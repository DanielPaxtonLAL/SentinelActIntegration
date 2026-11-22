# Sentinel-EMS - ACT-CRM - Integration

## Running
1. Install Node.js 20 or later: `winget install --id OpenJS.NodeJS.LTS --exact`. In a **new terminal**, verify the installation with `node -v` and `npm -v`.

2. Install the project packages with `npm run install`.

3. Copy `.env.example` to `.env`. Fill out the fields as required. You may not need to configure the test EMS routes; it's fine to leave them blank. **NOTE**: `PRODUCTION_EMS_INSECURE=1` means we are ignoring the outdated Sentinel-EMS certificate for HTTPS; `0` means we are not expecting a certificate for HTTP. `<mode>_EMS_USER_TYPE` can remain `ISV`. The API version is `v90`.

4. Optionally, you may need to adjust `entitlement-form-data.json`. Run `.\config-helper-scripts\get-ems-products.ps1 https://your-ems-host:8080` to get `product_id` values from the EMS. Enter them manually in the JSON file. The `next-serial-number-customer-id` values select the customer whose Ref ID 1 stores the next number as JSON, for example `{"NextSerial":"06003"}`.

When serials are first requested after EMS login, the app scans existing base-product entitlements and sets the counter to the highest valid serial number plus one, starting at 06001. Out-of-range values are skipped. New drafts use that number and advance the counter, so gaps are not reused. Serial numbers are padded to five digits.

5. Lastly, run `npm run dev -- --test` or `npm run dev -- --production`. The output will provide links to access the application.

## Security
This integration passes authentication along to Sentinel-EMS and ACT!, so communicating with them over HTTP is **INSECURE**.

Sentinel-EMS doesn't have an up-to-date certificate, so the security mode ignores the certificate.

This root directory should contain no secrets. The ACT! saved password is encrypted with the EMS credentials and stored in the browser's local storage. Inspect this with `inspect|storage|local-storage`.

Sentinel-EMS provides a session cookie, which is stored in your browser's cookies.
