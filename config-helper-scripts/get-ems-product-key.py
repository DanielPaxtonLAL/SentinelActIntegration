#!/usr/bin/env python3
"""Print the raw EMS product-key details for a product key ID."""

import argparse
import getpass
import http.cookiejar
import importlib
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request


sys.dont_write_bytecode = True
ems = importlib.import_module("get-ems-activations")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("product_key_id", nargs="?", help="Product key ID; prompted for if omitted")
    parser.add_argument("--base-url", help="EMS server origin; omitted URLs use .env")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--test", action="store_true", help="Use TEST_EMS_* settings from .env")
    mode.add_argument("--production", action="store_true", help="Use PRODUCTION_EMS_* settings from .env")
    parser.add_argument("--api-version", help="Override the EMS API version")
    parser.add_argument("--user-type", help="Override the EMS user type")
    tls = parser.add_mutually_exclusive_group()
    tls.add_argument("--insecure", action="store_true", help="Disable TLS verification for this EMS connection")
    tls.add_argument("--secure", action="store_true", help="Enable TLS verification")
    args = parser.parse_args()

    product_key_id = args.product_key_id
    if product_key_id is None:
        print("Product key ID: ", end="", file=sys.stderr, flush=True)
        product_key_id = input()
    product_key_id = product_key_id.strip()
    if not product_key_id:
        raise ValueError("A product key ID is required.")

    env = ems.load_dotenv()
    env.update({name: value for name, value in os.environ.items()
                if name.startswith(("TEST_", "PRODUCTION_", "EMS_", "IS_TEST_MODE"))})
    base, api_version, user_type, insecure = ems.resolve_connection(args, env)
    base_origin = ems.origin(base)
    if not (api_version.startswith("v") and api_version[1:].isdigit()):
        raise ValueError("EMS API version must look like v90.")
    base = base.rstrip("/")
    if insecure:
        print("Warning: TLS certificate verification is disabled.", file=sys.stderr)
    if base_origin[0] == "http":
        print("Warning: HTTP sends EMS credentials and product key data without encryption.", file=sys.stderr)
    print("The response may contain customer and product key details; handle it securely.", file=sys.stderr)

    username = env.get("EMS_USER", "").strip()
    password = env.get("EMS_PASS", "")
    if not username:
        print("EMS username: ", end="", file=sys.stderr, flush=True)
        username = input().strip()
    if not password:
        password = getpass.getpass("EMS password: ") if sys.stdin.isatty() else sys.stdin.readline().rstrip("\r\n")
    if not username or not password:
        raise ValueError("EMS username and password are required.")

    cookies = http.cookiejar.CookieJar()
    context = ssl._create_unverified_context() if insecure else ssl.create_default_context()
    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(cookies),
        urllib.request.HTTPSHandler(context=context),
        ems.SameOriginRedirect(base_origin),
    )
    ems.request(opener, base + "/ems/login.html", accept="text/html", allow_login=True)
    body = urllib.parse.urlencode({
        "username": username, "password": password, "user_type": user_type,
    }).encode("utf-8")
    del password
    _, _, login_url = ems.request(opener, base + "/ems/verifyLogin.html", body, accept="text/html")
    if "homepage" not in urllib.parse.urlsplit(login_url).path.lower() or not any(
        cookie.name == "JSESSIONID" for cookie in cookies
    ):
        raise ValueError("EMS login failed. Check the URL, credentials and user type.")

    url = base + "/ems/" + api_version + "/ws/productKey/" + urllib.parse.quote(product_key_id, safe="") + ".ws"
    data, headers, _ = ems.request(opener, url)
    if "text/html" in headers.get("Content-Type", "").lower():
        raise ValueError("EMS returned HTML instead of product key details.")
    sys.stdout.buffer.write(data)
    if not data.endswith(b"\n"):
        sys.stdout.buffer.write(b"\n")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, urllib.error.URLError, EOFError) as error:
        print("Error: " + str(error), file=sys.stderr)
        sys.exit(1)
