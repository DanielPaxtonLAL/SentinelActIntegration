# Sentinel-EMS - ACT-CRM - Integration

## Running
1. Install Node.js 20 or later: `winget install --id OpenJS.NodeJS.LTS --exact`. In a **new terminal**, verify the installation with `node -v` and `npm -v`.

2. Install the project packages with `npm run install`.

3. Copy `.env.example` to `.env`. Fill out the fields as required. You may not need to configure the test EMS routes; it's fine to leave them blank. **NOTE**: `PRODUCTION_EMS_INSECURE=1` means we are ignoring the outdated Sentinel-EMS certificate for HTTPS; `0` means we are not expecting a certificate for HTTP. `<mode>_EMS_USER_TYPE` can remain `ISV`. The API version is `v90`.

4. Optionally, you may need to adjust `entitlement-form-data.json`. Run `.\config-helper-scripts\get-ems-products.ps1 https://your-ems-host:8080` to get `product_id` values from the EMS. Enter them manually in the JSON file. The `next-serial-number-customer-id` values select the customer whose Ref ID 1 stores the next number as JSON, for example `{"NextSerial":"06003"}`.

To inspect the raw EMS response for a product key, run `python .\config-helper-scripts\get-ems-product-key.py` and enter the key ID. The script uses the configured EMS mode and prompts for credentials if needed; use `--test` or `--production` to select a mode explicitly. Its output can contain customer and product-key details.

When serials are first requested after EMS login, the app scans existing base-product entitlements and sets the counter to the highest valid serial number plus one, starting at 06001. Out-of-range values are skipped. New drafts use that number and advance the counter, so gaps are not reused. Serial numbers are padded to five digits.

5. Lastly, run `npm run dev -- --test` or `npm run dev -- --production`. The output will provide links to access the application.

To fetch pending updates, open **Fetch pending updates (V2CP)** on an entitlement and upload a current C2V. Download the returned V2CP and apply it using the Sentinel Runtime API or Admin Control Center. EMS returns all pending updates for the protection key in the C2V, not just the selected product key or entitlement. The target needs RTE 7.63 or later and must not be an SL-Legacy key. The app does not poll automatically; if EMS is unavailable or busy, the guide recommends retrying after 60 minutes.

The **Product Keys** tab scans entitlement product keys and retrieves licenses for activation IDs returned by EMS. Keys without a returned activation ID are also listed, but no license can be fetched for them; they may not be activated.
Use **Get activation history** on a row with a protection key ID to look up associated entitlements, including protection-key updates, and download the V2Cs for activation IDs EMS returns. The list sorts available key-history update counters highest first; counters are EMS history, not confirmation of what has been applied on the customer machine. Missing product keys or activation IDs are reported, so the list may be incomplete.
Use **Get V2CP** on the Product Keys tab to build a package from that key's existing V2Cs in ascending update-counter order. It may contain updates already applied and does not check the current key state. Package creation fails if history has warnings, missing licenses, or counters that do not form a complete sequence starting at zero. This history-based package is constructed locally, not returned by the EMS pending-update service.
If the saved C2V is invalid XML, the server logs its format, size, validation position and structural clues, without logging its contents.

## Security
This integration passes authentication along to Sentinel-EMS and ACT!, so communicating with them over HTTP is **INSECURE**.

Sentinel-EMS doesn't have an up-to-date certificate, so the security mode ignores the certificate.

This root directory should contain no secrets. The ACT! saved password is encrypted with the EMS credentials and stored in the browser's local storage. Inspect this with `inspect|storage|local-storage`.

Sentinel-EMS provides a session cookie, which is stored in your browser's cookies.

`New-NetFirewallRule -DisplayName "Sentinel Integration" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 -Profile Domain -RemoteAddress LocalSubnet` will allow other devices to connect to this 

