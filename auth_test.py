
import requests
import getpass
import base64
import json
import sys

# --------------------------------------------------
# Configuration
# --------------------------------------------------

BASE_URL = "http://VLALACT2/Act.Web.API"
DATABASE_NAME = "Irricad"

TIMEOUT = 30


# --------------------------------------------------
# Authentication
# --------------------------------------------------

def authenticate():

    username = input("Act! username: ")
    password = getpass.getpass("Act! password: ")

    credentials = f"{username}:{password}".encode("utf-8")
    encoded_credentials = base64.b64encode(credentials).decode("ascii")

    headers = {
        "Authorization": f"Basic {encoded_credentials}",
        "Act-Database-Name": DATABASE_NAME,
        "Accept": "application/json"
    }

    print("\nAuthenticating with Act!...")

    response = requests.get(
        f"{BASE_URL}/authorize",
        headers=headers,
        timeout=TIMEOUT
    )

    print(f"Authentication status: {response.status_code}")

    response.raise_for_status()

    # Act! returns the bearer token as plain text.
    token = response.text.strip()

    if not token:
        raise RuntimeError("Act! returned an empty authentication token.")

    print("Authentication successful!")
    print(f"Token length: {len(token)} characters")

    return token


# --------------------------------------------------
# Retrieve companies
# --------------------------------------------------

def get_companies(token):

    print("\nRetrieving companies...")

    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json"
    }

    response = requests.get(
        f"{BASE_URL}/api/companies",
        headers=headers,
        timeout=TIMEOUT
    )

    print(f"Companies status: {response.status_code}")

    response.raise_for_status()

    try:
        companies = response.json()

    except requests.exceptions.JSONDecodeError:
        print("\nUnexpected response format:")
        print(response.text[:5000])
        return None

    return companies


# --------------------------------------------------
# Display companies
# --------------------------------------------------

def display_companies(companies):

    print("\n" + "=" * 60)
    print("ACT! COMPANIES")
    print("=" * 60)

    if isinstance(companies, list):

        print(f"\nTotal companies returned: {len(companies)}")

        for index, company in enumerate(companies, start=1):

            print(f"\nCompany {index}")
            print("-" * 40)

            if isinstance(company, dict):
                for key, value in company.items():
                    print(f"{key}: {value}")
            else:
                print(company)

    elif isinstance(companies, dict):

        # Some APIs wrap collections inside an object.
        print(json.dumps(companies, indent=4, ensure_ascii=False))

    else:
        print(companies)


# --------------------------------------------------
# Save response
# --------------------------------------------------

def save_companies(companies):

    filename = "act_companies.json"

    with open(filename, "w", encoding="utf-8") as file:
        json.dump(
            companies,
            file,
            indent=4,
            ensure_ascii=False
        )

    print(f"\nCompanies saved to: {filename}")


# --------------------------------------------------
# Main
# --------------------------------------------------

def main():

    try:

        token = authenticate()

        companies = get_companies(token)

        if companies is not None:

            display_companies(companies)

            save_companies(companies)

            print("\nFinished successfully!")

    except requests.exceptions.HTTPError as error:

        print(f"\nHTTP error: {error}")

        if error.response is not None:
            print("Server response:")
            print(error.response.text[:3000])

    except requests.exceptions.ConnectionError:

        print("\nCould not connect to the Act! server.")
        print("Check network connectivity and server availability.")

    except requests.exceptions.Timeout:

        print("\nThe request timed out.")

    except requests.exceptions.RequestException as error:

        print(f"\nRequest error: {error}")

    except KeyboardInterrupt:

        print("\nOperation cancelled.")

    except Exception as error:

        print(f"\nUnexpected error: {error}")


if __name__ == "__main__":
    main()
