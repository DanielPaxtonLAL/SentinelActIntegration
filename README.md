# Sentinel-EMS - ACT-CRM - Integration
~~Copilot stop adding stuff here~~
## Running
### Setup
#### 1. Install Node.js 20 or later:

```powershell
winget install --id OpenJS.NodeJS.LTS --exact
```

Verify the installation in a **new terminal**:
```powershell
node -v
npm -v
```
#### 2. Install the project packages using Node Package Manager (npm).
```powershell
npm run install
```

#### 3. Copy the example dotenv to a dotenv file. 
```powershell
Copy-Item .\.env.example .\.env
```
Fill out the fields as required. You may not need to configure the test EMS routes; it's fine to leave them blank. 

**NOTES**: **"[mode]_EMS_INSECURE=1"** means we are ignoring the outdated Sentinel-EMS certificate for HTTPS; **"[mode]_EMS_INSECURE=0"** means we are not expecting a certificate for HTTP. **"[mode]_EMS_USER_TYPE"** can remain **"ISV"** (**I**ndependent **S**oftware **V**endor). The API version is **"v90"**.

#### 4. Optionally, you may need to adjust `.\entitlement-form-data.json`. 
 To get "product_id" values from the EMS, run the following, then enter them manually in the JSON file.

Run: 
```powershell
.\config-helper-scripts\get-ems-products.ps1 https://your-ems-host:8080
```
 The "next-serial-number-customer-id" values select the customer whose Ref ID 1 stores the next number as JSON, for example, `{"NextSerial": "06003"}`.
 The Protection Keys page reconstructs the expected Standalone, Link and Pivot states using their configured add/remove IDs and EMS activation counters. It does not confirm that updates have been applied; incomplete or unsupported history is shown as unavailable.

#### 5. Lastly, run with:
```powershell
npm run dev -- --test
``` 
or
 ```powershell
npm run dev -- --production
```
The output will provide links to access the application.
4. Optionally, you may need to adjust `entitlement-form-data.json`. Run `.\config-helper-scripts\get-ems-products.ps1 https://your-ems-host:8080` to get `product_id` values from the EMS. Enter them manually in the JSON file. The `next-serial-number-customer-id` values select the customer whose Ref ID 1 stores the next number as JSON, for example `{"NextSerial":"06003"}`. In the production server this is Lincoln Agritech with an id of 1.



5. Lastly, run `npm run dev -- --test` or `npm run dev -- --production`. The output will provide links to access the application.

### Optional
Debugging Python files exist in **".\config-helper-scripts"**. If you want to run them, you will need a Python 3+ interpreter.

```powershell
winget install --id Python.Python.3.14 --exact --override "/quiet InstallAllUsers=0 PrependPath=1"
```

In a new terminal, verify the installation:
```powershell
python --version
```

## Security
### HTTP(S) **INSECURE, UNVERIFIED**
This integration passes authentication along to Sentinel-EMS and ACT!, so communicating with them over HTTP is **INSECURE**.

Sentinel-EMS doesn't have an up-to-date certificate, so the security mode ignores the certificate.

### Credentials
This root directory should contain no secrets. The ACT! saved password is encrypted with the EMS credentials and stored in the browser's local storage. Inspect this with `inspect|storage|local-storage`.

Sentinel-EMS provides a session cookie, which is stored in your browser's cookies.

### Exposing to LAN 
``` powershell
New-NetFirewallRule -DisplayName "Sentinel Integration" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 -Profile Domain -RemoteAddress LocalSubnet
```
This will allow other devices to connect to the application.

## Test Suite
After installing the project packages, run the test suite from the project directory:

```powershell
npm test
```
`New-NetFirewallRule -DisplayName "Sentinel Integration" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 -Profile Domain -RemoteAddress LocalSubnet` will allow other devices to connect to this.

