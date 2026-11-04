
import requests
import getpass
import xml.etree.ElementTree as ET


# ============================================================
# CONFIGURATION
# ============================================================

EMS_BASE_URL = "http://10.6.91.24:8080"
API_VERSION = "v90"

API_ROOT = f"{EMS_BASE_URL.rstrip('/')}/ems/{API_VERSION}/ws"

TIMEOUT = 30


# ============================================================
# EMS CLIENT
# ============================================================

class EmsClient:

    def __init__(self, base_url):
        self.base_url = base_url.rstrip("/")
        self.api_root = f"{self.base_url}/ems/{API_VERSION}/ws"
        self.session = requests.Session()
        self.authenticated = False

    def authenticate(self, username, password):

        print("\nAuthenticating with Sentinel EMS...")

        url = f"{self.api_root}/login.ws"

        root = ET.Element("authenticationDetail")
        ET.SubElement(root, "userName").text = username
        ET.SubElement(root, "password").text = password

        payload = ET.tostring(root, encoding="unicode")

        response = self.session.post(
            url,
            data=payload.encode("utf-8"),
            headers={
                "Content-Type": "application/xml",
                "Accept": "application/xml"
            },
            timeout=TIMEOUT
        )

        print(f"Authentication status: {response.status_code}")

        if not response.ok:
            raise Exception(
                f"EMS authentication failed:\n{response.text}"
            )

        self.authenticated = True

        print("Authentication successful.")
        print("Session cookies:", list(self.session.cookies.keys()))

    def create_customer(
        self,
        name,
        vendor_id,
        external_reference="",
        description="",
        phone="",
        street="",
        city="",
        state="",
        country="",
        postcode=""
    ):

        if not self.authenticated:
            raise Exception("Not authenticated with EMS.")

        if not name:
            raise ValueError("Customer name is required.")

        if not vendor_id:
            raise ValueError("Vendor ID is required.")

        print(f"\nCreating EMS customer: {name}")

        root = ET.Element("customer")

        ET.SubElement(root, "type").text = "org"
        ET.SubElement(root, "enabled").text = "true"
        ET.SubElement(root, "name").text = name
        ET.SubElement(root, "description").text = description
        ET.SubElement(root, "crmId").text = external_reference
        ET.SubElement(root, "refId").text = external_reference
        ET.SubElement(root, "phone").text = phone

        if street or city or country:

            addresses = ET.SubElement(root, "addresses")
            address = ET.SubElement(addresses, "address")

            ET.SubElement(address, "type").text = "billing"
            ET.SubElement(address, "street").text = street
            ET.SubElement(address, "city").text = city
            ET.SubElement(address, "state").text = state
            ET.SubElement(address, "country").text = country
            ET.SubElement(address, "zip").text = postcode

        ET.SubElement(root, "vendorId").text = str(vendor_id)

        payload = ET.tostring(root, encoding="unicode")

        print("\nRequest XML:")
        print(payload)

        url = f"{self.api_root}/customer.ws"

        response = self.session.put(
            url,
            data=payload.encode("utf-8"),
            headers={
                "Content-Type": "application/xml",
                "Accept": "application/xml"
            },
            timeout=TIMEOUT
        )

        print("\nResponse status:", response.status_code)
        print("Response headers:", dict(response.headers))
        print("\nResponse body:")
        print(response.text)

        if response.status_code != 201:
            raise Exception(
                f"Customer creation failed: "
                f"{response.status_code}\n{response.text}"
            )

        customer_id = response.headers.get("Location")

        print("\nCustomer created successfully!")
        print("Customer ID:", customer_id)

        return customer_id


# ============================================================
# MAIN
# ============================================================

def main():

    print("=" * 55)
    print("SENTINEL LDK-EMS - CUSTOMER CREATION")
    print("=" * 55)

    username = input("\nEMS username: ")
    password = getpass.getpass("EMS password: ")

    ems = EmsClient(EMS_BASE_URL)

    try:

        ems.authenticate(username, password)

        print("\n--- New EMS Customer ---")

        name = input("Company name: ")
        external_reference = input("External reference (optional): ")
        vendor_id = input("EMS Vendor ID: ")

        description = input("Description (optional): ")
        phone = input("Phone (optional): ")

        print("\n--- Billing Address ---")

        street = input("Street: ")
        city = input("City: ")
        state = input("State: ")
        country = input("Country: ")
        postcode = input("Postcode: ")

        print("\n--- Confirmation ---")
        print("Company:", name)
        print("External reference:", external_reference)
        print("Vendor ID:", vendor_id)

        confirm = input("\nCreate this customer? (yes/no): ")

        if confirm.strip().lower() not in ("yes", "y"):
            print("Cancelled.")
            return

        ems.create_customer(
            name=name,
            vendor_id=vendor_id,
            external_reference=external_reference,
            description=description,
            phone=phone,
            street=street,
            city=city,
            state=state,
            country=country,
            postcode=postcode
        )

        print("\nFinished.")

    except requests.RequestException as e:
        print("\nHTTP/network error:", e)

    except Exception as e:
        print("\nError:", e)

    finally:
        ems.session.close()


if __name__ == "__main__":
    main()
