#!/usr/bin/env python3
"""Authenticate to EMS and print the entitlements response in a readable layout."""

import argparse
import http.cookiejar
import os
from pathlib import Path
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.dom.minidom
import xml.parsers.expat


def load_env():
    env_file = Path(__file__).resolve().with_name(".env")
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        if key:
            os.environ.setdefault(key, value)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def format_node(node, depth=0):
    indent = "  " * depth
    attributes = [(node.attributes.item(i).name, node.attributes.item(i).value)
                  for i in range(node.attributes.length)]
    children = [child for child in node.childNodes if child.nodeType == child.ELEMENT_NODE]
    text = "".join(child.data for child in node.childNodes
                   if child.nodeType in (child.TEXT_NODE, child.CDATA_SECTION_NODE)).strip()
    if not attributes and not children:
        return f"{indent}{node.tagName}: {text or '-'}"
    width = max((len(name) for name, _ in attributes), default=0)
    lines = [f"{indent}[{node.tagName}]"]
    lines += [f"{indent}  {name.ljust(width)} : {value if value != '' else '-'}"
              for name, value in attributes]
    if text:
        lines.append(f"{indent}  {text}")
    for child in children:
        if child.tagName == "instance":
            lines.append("")
        lines.append(format_node(child, depth + 1))
    return "\n".join(lines)


def child_text(node, tag):
    for child in node.childNodes:
        if child.nodeType == child.ELEMENT_NODE and child.tagName == tag:
            return "".join(c.data for c in child.childNodes
                           if c.nodeType in (c.TEXT_NODE, c.CDATA_SECTION_NODE)).strip() or "-"
    return "-"


def format_summary(entitlement):
    """Entitlement and line-item fields plus product names, without product feature/license detail."""
    def fields(node, skip):
        return [f"{child.tagName}: {child_text(node, child.tagName)}"
                for child in node.childNodes
                if child.nodeType == child.ELEMENT_NODE and child.tagName not in skip
                and not any(c.nodeType == c.ELEMENT_NODE for c in child.childNodes)]

    lines = ["[entitlement]"]
    lines += ["  " + line for line in fields(entitlement, set())]
    for item in entitlement.getElementsByTagName("entitlementItem"):
        lines.append("  [entitlementItem]")
        lines += ["    " + line for line in fields(item, set())]
        for product in item.getElementsByTagName("itemProduct"):
            details = next((c for c in product.childNodes
                            if c.nodeType == c.ELEMENT_NODE and c.tagName == "product"), None)
            name = child_text(details, "productName") if details else "-"
            lines.append(f"    product {child_text(product, 'productId')}: {name}")
    return "\n".join(lines)


def main(eid=None, summary=False):
    load_env()
    base_url = os.environ.get("EMS_URL", "").rstrip("/")
    username = os.environ.get("EMS_USER", "")
    password = os.environ.get("EMS_PASS", "")
    if not base_url or not username or not password:
        raise ValueError("Set EMS_URL, EMS_USER and EMS_PASS in .env or the environment.")
    parsed_url = urllib.parse.urlsplit(base_url)
    if parsed_url.scheme not in ("http", "https") or not parsed_url.netloc:
        raise ValueError("EMS_URL must be an HTTP or HTTPS URL.")

    cookies = http.cookiejar.CookieJar()
    context = (
        ssl._create_unverified_context()
        if os.environ.get("EMS_INSECURE") == "1"
        else ssl.create_default_context()
    )
    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(cookies),
        urllib.request.HTTPSHandler(context=context),
        NoRedirect(),
    )
    with opener.open(base_url + "/ems/login.html", timeout=30):
        pass

    form = urllib.parse.urlencode({
        "username": username,
        "password": password,
        "user_type": os.environ.get("EMS_USER_TYPE", "ISV"),
    }).encode("utf-8")
    request = urllib.request.Request(
        base_url + "/ems/verifyLogin.html",
        data=form,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with opener.open(request, timeout=30) as response:
            raise RuntimeError(f"EMS login failed (HTTP {response.status}).")
    except urllib.error.HTTPError as error:
        location = error.headers.get("Location", "")
        if error.code != 302 or "homepage" not in location.lower():
            raise RuntimeError(f"EMS login failed (HTTP {error.code}).") from error
    if not any(cookie.name == "JSESSIONID" for cookie in cookies):
        raise RuntimeError("EMS login succeeded but no JSESSIONID cookie was returned.")

    version = os.environ.get("EMS_API_VERSION", "v90")

    def get_xml(path):
        request = urllib.request.Request(
            f"{base_url}/ems/{version}/ws/{path}",
            headers={"Accept": "application/xml, application/json"},
        )
        with opener.open(request, timeout=30) as response:
            return response.read()

    content = get_xml("entitlement.xml")
    if eid:
        listing = xml.dom.minidom.parseString(content).documentElement
        match = next((node for node in listing.getElementsByTagName("instance")
                      if node.getAttribute("eid").lower() == eid.lower()), None)
        if match is None:
            raise ValueError(f"No entitlement found with eid {eid}.")
        content = get_xml(f"entitlement/{match.getAttribute('id')}.xml")
        if summary:
            sys.stdout.buffer.write((format_summary(xml.dom.minidom.parseString(content).documentElement) + "\n").encode("utf-8"))
            return
    root = xml.dom.minidom.parseString(content).documentElement
    sys.stdout.buffer.write((format_node(root) + "\n").encode("utf-8"))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Print EMS entitlements.")
    parser.add_argument("--eid", help="print only the entitlement with this EID (GUID), including its full details")
    parser.add_argument("--summary", action="store_true",
                        help="with --eid, print only the entitlement fields and product names/IDs")
    args = parser.parse_args()
    if args.summary and not args.eid:
        parser.error("--summary requires --eid")
    try:
        main(args.eid, args.summary)
    except (OSError, ValueError, RuntimeError, xml.parsers.expat.ExpatError) as error:
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)
