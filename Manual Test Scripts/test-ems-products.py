#!/usr/bin/env python3
"""Authenticate to EMS and print product names and IDs.

With --product-id, print only that product and its modification products.
"""

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

PAGE_SIZE = 100


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


def login():
    """Log in to EMS and return (opener, api_root)."""
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
    return opener, f"{base_url}/ems/{version}/ws"


def parse(content):
    return xml.dom.minidom.parseString(content).documentElement


def text_of(node, tag):
    for child in node.childNodes:
        if child.nodeType == child.ELEMENT_NODE and child.tagName == tag:
            return "".join(c.data for c in child.childNodes
                           if c.nodeType in (c.TEXT_NODE, c.CDATA_SECTION_NODE)).strip()
    return ""


def main(product_id=None):
    load_env()
    opener, api_root = login()
    vendor_id = os.environ.get("EMS_VENDOR_ID", "2")

    def get_xml(path):
        request = urllib.request.Request(
            f"{api_root}/{path}",
            headers={"Accept": "application/xml, application/json"},
        )
        with opener.open(request, timeout=30) as response:
            return parse(response.read())

    def list_products(identifier=None):
        products = []
        for page in range(1, 1000):
            query = {"pageIndex": page, "pageSize": PAGE_SIZE}
            if identifier:
                query["identifier"] = identifier
            listing = get_xml(f"vendor/{vendor_id}/product.ws?{urllib.parse.urlencode(query)}")
            instances = listing.getElementsByTagName("instance")
            products += [{name: node.getAttribute(name)
                          for name in ("id", "name", "type", "identifier", "lifeCycleStage")}
                         for node in instances]
            if len(instances) < PAGE_SIZE:
                return products
        raise RuntimeError("EMS returned too many product pages.")

    if product_id:
        detail = get_xml(f"product/{product_id}.ws")
        identifier = text_of(detail, "productIdentifier")
        if not identifier:
            raise ValueError(f"Product {product_id} was not found or has no identifier.")
        candidates = [p for p in list_products(identifier) if p["type"].upper() == "MODIFICATION"]
        modifications = [p for p in candidates
                         if text_of(get_xml(f"product/{p['id']}.ws"), "baseProductId") == str(product_id)]
        rows = [{"id": str(product_id), "name": text_of(detail, "productName"),
                 "type": text_of(detail, "enforcementProductType") or "BASE",
                 "lifeCycleStage": text_of(detail, "lifeCycleStage")}]
        rows += modifications
        print(f"Product {product_id} and its {len(modifications)} modification(s)")
    else:
        rows = list_products()
        print(f"{len(rows)} product(s)")

    id_width = max([len("ID")] + [len(row["id"]) for row in rows])
    type_width = max([len("TYPE")] + [len(row["type"]) for row in rows])
    print(f"{'ID'.ljust(id_width)}  {'TYPE'.ljust(type_width)}  NAME")
    for row in rows:
        indent = "  " if product_id and row["id"] != str(product_id) else ""
        print(f"{row['id'].ljust(id_width)}  {row['type'].ljust(type_width)}  {indent}{row['name']}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Print EMS product names and IDs.")
    parser.add_argument("--product-id", type=int,
                        help="only print this product (by its EMS id) and its modification products")
    args = parser.parse_args()
    try:
        main(args.product_id)
    except (OSError, ValueError, RuntimeError, xml.parsers.expat.ExpatError) as error:
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)
