#!/usr/bin/env python3
"""Print the EMS activation report and complete XML for discoverable activations."""

import argparse
import getpass
import http.cookiejar
import os
from pathlib import Path
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET


def origin(url):
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password:
        raise ValueError("EMS URL must be an HTTP(S) origin without credentials.")
    if parts.path not in ("", "/") or parts.query or parts.fragment:
        raise ValueError("EMS URL must be an origin without a path, query, or fragment.")
    return parts.scheme, parts.hostname.lower(), parts.port or (443 if parts.scheme == "https" else 80)


class SameOriginRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, base_origin):
        self.base_origin = base_origin

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parts = urllib.parse.urlsplit(newurl)
        destination = urllib.parse.urlunsplit((parts.scheme, parts.netloc, "", "", ""))
        if origin(destination) != self.base_origin:
            raise ValueError("EMS attempted to redirect to a different origin.")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def request(opener, url, data=None, accept="application/xml", allow_login=False):
    headers = {"Accept": accept}
    if data is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=data, headers=headers)
    with opener.open(req, timeout=60) as response:
        if not allow_login and "/login" in urllib.parse.urlsplit(response.geturl()).path.lower():
            raise ValueError("EMS redirected to login; authentication may have expired.")
        return response.read(), response.headers, response.geturl()


def xml_root(data, expected):
    root = ET.fromstring(data)
    if root.tag != expected:
        raise ValueError("EMS returned an unexpected XML response; expected " + expected + ".")
    return root


def activation_ids(root):
    ids = set()
    for element in root.iter():
        name = element.tag.rsplit("}", 1)[-1].lower().replace("_", "").replace("-", "")
        if name in ("aid", "activationid") and element.text and element.text.strip():
            ids.add(element.text.strip())
        for key, value in element.attrib.items():
            name = key.rsplit("}", 1)[-1].lower().replace("_", "").replace("-", "")
            if name in ("aid", "activationid") and value.strip():
                ids.add(value.strip())
    return sorted(ids)


def parse_dotenv_line(raw_line):
    if not raw_line:
        return None
    line = raw_line.strip()
    if not line or line.startswith("#") or "=" not in line:
        return None
    name, value = line.split("=", 1)
    name = name.strip()
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        value = value[1:-1]
    else:
        comment = value.find(" #")
        if comment >= 0:
            value = value[:comment].rstrip()
    if not name:
        return None
    return name, value


def load_dotenv():
    env_path = Path(__file__).resolve().parent.parent / ".env"
    values = {}
    if not env_path.is_file():
        return values
    for raw_line in env_path.read_text(encoding="utf-8-sig").splitlines():
        parsed = parse_dotenv_line(raw_line)
        if parsed is None:
            continue
        name, value = parsed
        if name:
            values[name] = value
    return values


def resolve_connection(args, env):
    mode_names = []
    if args.test:
        mode_names.append("TEST")
    if args.production:
        mode_names.append("PRODUCTION")
    if not mode_names:
        is_test = env.get("IS_TEST_MODE", "").strip().lower()
        if is_test in ("true", "1", "yes", "on"):
            mode_names.append("TEST")
        elif is_test in ("false", "0", "no", "off"):
            mode_names.append("PRODUCTION")

    if args.base_url:
        base = args.base_url
        matches = []
        for prefix in ("TEST", "PRODUCTION"):
            configured = env.get(prefix + "_EMS_URL", "").strip()
            if configured and configured.rstrip("/") == base.rstrip("/"):
                matches.append(prefix)
        if len(matches) > 1:
            raise ValueError("The test and production EMS URLs must be different.")
        prefix = matches[0] if matches else None
    elif mode_names:
        prefix = mode_names[0]
        base = env.get(prefix + "_EMS_URL", "").strip()
        if not base:
            raise ValueError("Set " + prefix + "_EMS_URL in .env.")
    else:
        raise ValueError("Use --test or --production, or set IS_TEST_MODE in .env.")

    if prefix:
        api_version = args.api_version or env.get(prefix + "_EMS_API_VERSION", "").strip() or "v90"
        user_type = args.user_type or env.get(prefix + "_EMS_USER_TYPE", "").strip() or "ISV"
        insecure_value = env.get(prefix + "_EMS_INSECURE", "").strip()
        if args.insecure:
            insecure = True
        elif args.secure:
            insecure = False
        else:
            if insecure_value not in ("", "0", "1"):
                raise ValueError(prefix + "_EMS_INSECURE must be 0 or 1.")
            insecure = insecure_value == "1"
    else:
        api_version = args.api_version or env.get("EMS_API_VERSION", "").strip() or "v90"
        user_type = args.user_type or env.get("EMS_USER_TYPE", "").strip() or "ISV"
        insecure = args.insecure
        if args.secure:
            insecure = False

    return base, api_version, user_type, insecure


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("base_url", nargs="?", help="EMS server origin; omitted URLs use .env")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--test", action="store_true", help="Use TEST_EMS_* settings from .env")
    mode.add_argument("--production", action="store_true", help="Use PRODUCTION_EMS_* settings from .env")
    parser.add_argument("--api-version", help="Override the EMS API version")
    parser.add_argument("--user-type", help="Override the EMS user type")
    parser.add_argument("--insecure", action="store_true", help="Disable TLS verification for this EMS connection")
    parser.add_argument("--secure", action="store_true", help="Enable TLS verification")
    args = parser.parse_args()
    if args.insecure and args.secure:
        parser.error("--insecure and --secure cannot be used together")

    env = load_dotenv()
    env.update({name: value for name, value in os.environ.items() if name.startswith(("TEST_", "PRODUCTION_", "EMS_", "IS_TEST_MODE"))})
    base, api_version, user_type, insecure = resolve_connection(args, env)

    base_origin = origin(base)
    if not (api_version.startswith("v") and api_version[1:].isdigit()):
        raise ValueError("EMS API version must look like v90.")
    base = base.rstrip("/")
    if insecure:
        print("Warning: TLS certificate verification is disabled.", file=sys.stderr)
    if base_origin[0] == "http":
        print("Warning: HTTP sends EMS credentials and activation data without encryption.", file=sys.stderr)
    print("Output may contain customer details, product keys, C2V data and V2C licenses; handle it securely.", file=sys.stderr)
    print("The report is a summary; full XML is available only for activation IDs returned by product keys.", file=sys.stderr)

    username = env.get("EMS_USER", "").strip()
    password = env.get("EMS_PASS", "")
    if not username:
        username = input("EMS username: ").strip()
    if not password:
        password = getpass.getpass("EMS password: ") if sys.stdin.isatty() else sys.stdin.readline().rstrip("\r\n")
    if not username or not password:
        raise ValueError("EMS username and password are required.")
    cookies = http.cookiejar.CookieJar()
    context = ssl._create_unverified_context() if insecure else ssl.create_default_context()
    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(cookies),
        urllib.request.HTTPSHandler(context=context),
        SameOriginRedirect(base_origin),
    )
    request(opener, base + "/ems/login.html", accept="text/html", allow_login=True)
    body = urllib.parse.urlencode({
        "username": username, "password": password, "user_type": user_type,
    }).encode("utf-8")
    del password
    _, _, login_url = request(opener, base + "/ems/verifyLogin.html", body, accept="text/html")
    if "homepage" not in urllib.parse.urlsplit(login_url).path.lower() or not any(
        cookie.name == "JSESSIONID" for cookie in cookies
    ):
        raise ValueError("EMS login failed. Check the URL, credentials and user type.")

    api = base + "/ems/" + api_version + "/ws"
    report, _, _ = request(opener, api + "/report/CustomerActivationReport.ws?format=csv", accept="text/csv")
    report_text = report.decode("utf-8-sig")
    if report_text.lstrip().lower().startswith(("<!doctype html", "<html")):
        raise ValueError("EMS returned HTML instead of the activation report.")
    print("\n=== Customer Activation Report (CSV) ===")
    print(report_text)
    print("=== Full activation XML discovered through product keys ===")

    seen_entitlements = set()
    seen_keys = {}
    seen_activations = set()
    unresolved = 0
    page = 1
    while True:
        data, headers, _ = request(opener, api + "/entitlement.ws?pageIndex=" + str(page) + "&pageSize=100")
        root = xml_root(data, "listResponse")
        total_header = headers.get("X-Total-Count")
        if total_header is None or not total_header.isdigit():
            raise ValueError("EMS did not return a valid X-Total-Count for entitlement pagination.")
        total = int(total_header)
        if total < len(seen_entitlements):
            raise ValueError("EMS entitlement count changed while paging.")
        entries = root.findall("instance")
        if not entries and len(seen_entitlements) < total:
            raise ValueError("EMS returned an incomplete entitlement page.")
        for entry in entries:
            ent_id = entry.get("id", "")
            if not ent_id.isdigit() or int(ent_id) < 1 or ent_id in seen_entitlements:
                raise ValueError("EMS returned a missing, invalid, or duplicate entitlement ID.")
            seen_entitlements.add(ent_id)
            detail, _, _ = request(opener, api + "/entitlement/" + ent_id + ".ws")
            entitlement = xml_root(detail, "entitlement")
            state = (entitlement.findtext("entState") or "").strip().upper()
            for item in entitlement.findall("entitlementItem"):
                if (item.findtext("lineItemType") or "").strip() != "Product_Key":
                    continue
                keys = [element.text.strip() for element in item.findall("productKeyId") if element.text and element.text.strip()]
                if not keys and state != "DRAFT":
                    print("Warning: entitlement " + ent_id + " has a Product_Key item without a product key ID.", file=sys.stderr)
                    unresolved += 1
                for key in keys:
                    if key in seen_keys and seen_keys[key] != ent_id:
                        raise ValueError("EMS returned the same product key for multiple entitlements.")
                    if key in seen_keys:
                        continue
                    seen_keys[key] = ent_id
                    key_data, _, _ = request(opener, api + "/productKey/" + urllib.parse.quote(key, safe="") + ".ws")
                    key_xml = xml_root(key_data, "productKey")
                    if (key_xml.findtext("productKeyId") or "").strip() != key or (
                        key_xml.findtext("entitlementId") or ""
                    ).strip() != ent_id:
                        raise ValueError("EMS returned product key details for an unexpected key or entitlement.")
                    aids = activation_ids(key_xml)
                    if not aids:
                        print("\n--- Product key without an activation ID, entitlement " + ent_id + " ---")
                        print(key_data.decode("utf-8-sig"))
                        unresolved += 1
                    for aid in aids:
                        if aid in seen_activations:
                            continue
                        activation, _, _ = request(opener, api + "/activation/" + urllib.parse.quote(aid, safe="") + ".ws")
                        activation_xml = xml_root(activation, "activation")
                        if aid not in activation_ids(activation_xml):
                            raise ValueError("EMS returned activation details for an unexpected activation ID.")
                        seen_activations.add(aid)
                        print("\n--- Activation " + aid + ", entitlement " + ent_id + " ---")
                        print(activation.decode("utf-8-sig"))
        if len(seen_entitlements) >= total:
            break
        page += 1
    print("\nRetrieved " + str(len(seen_activations)) + " activation XML record(s).", file=sys.stderr)
    if unresolved:
        print(
            "Warning: " + str(unresolved) + " product key item(s) had no activation ID; "
            "some may be unactivated, and full activation details may be missing.",
            file=sys.stderr,
        )


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, urllib.error.URLError, ET.ParseError) as error:
        print("Error: " + str(error), file=sys.stderr)
        sys.exit(1)
