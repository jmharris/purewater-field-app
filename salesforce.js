/**
 * Thin Salesforce API wrapper: OAuth 2.0 User-Agent Flow (the token comes
 * back directly in the redirect URL fragment -- no server-side token
 * exchange call, which sidesteps Salesforce's CORS restriction on the
 * /services/oauth2/token endpoint for non-Salesforce-hosted origins like
 * GitHub Pages). Also provides the REST/Query API helpers used by the
 * rest of the app.
 *
 * Tradeoff vs. the Web Server + PKCE flow: no refresh token, so a
 * technician re-logs in whenever their session expires rather than it
 * refreshing silently -- an acceptable tradeoff for a small internal
 * field tool used a few times a day.
 *
 * Tokens are kept in sessionStorage only (cleared when the tab closes),
 * never localStorage -- avoids leaving a long-lived access token sitting
 * around on a shared/borrowed device.
 */

const SF_LOGIN_HOST = "https://business-efficiency-952.my.salesforce.com";
const SF_CLIENT_ID =
  "3MVG9jSKmPAPVo2Lgm87quozhGwsHrJ_EPgJ8xV_kbRjlbS8l6hwCmotOTPVquJULpJfBLpXhFFC8yIrf2sOK";
const SF_API_VERSION = "v67.0";

// Must exactly match the Callback URL configured on the External Client
// App in Salesforce Setup.
function getRedirectUri() {
  return window.location.origin + window.location.pathname.replace(/index\.html$/, "") + "callback.html";
}

const STORAGE_KEYS = {
  accessToken: "sf_access_token",
  instanceUrl: "sf_instance_url",
};

/** Kicks off login: redirects the browser to Salesforce's authorize page. */
function login() {
  const params = new URLSearchParams({
    response_type: "token",
    client_id: SF_CLIENT_ID,
    redirect_uri: getRedirectUri(),
    scope: "api",
  });

  window.location.href = `${SF_LOGIN_HOST}/services/oauth2/authorize?${params.toString()}`;
}

/**
 * Called from callback.html after Salesforce redirects back with the
 * token in the URL fragment (#access_token=...&instance_url=...).
 * No network call needed -- the User-Agent flow hands back the token
 * directly, which is what avoids the CORS block on the token endpoint.
 */
function handleCallback() {
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const accessToken = hashParams.get("access_token");
  const instanceUrl = hashParams.get("instance_url");
  const error = hashParams.get("error");

  if (error) {
    throw new Error(`OAuth error: ${error} - ${hashParams.get("error_description") || ""}`);
  }
  if (!accessToken || !instanceUrl) {
    throw new Error("No access token returned from Salesforce.");
  }

  sessionStorage.setItem(STORAGE_KEYS.accessToken, accessToken);
  sessionStorage.setItem(STORAGE_KEYS.instanceUrl, instanceUrl);
}

function isLoggedIn() {
  return Boolean(sessionStorage.getItem(STORAGE_KEYS.accessToken));
}

function logout() {
  sessionStorage.removeItem(STORAGE_KEYS.accessToken);
  sessionStorage.removeItem(STORAGE_KEYS.instanceUrl);
}

function getAuthHeaders() {
  const token = sessionStorage.getItem(STORAGE_KEYS.accessToken);
  if (!token) {
    throw new Error("Not logged in.");
  }
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function getInstanceUrl() {
  const url = sessionStorage.getItem(STORAGE_KEYS.instanceUrl);
  if (!url) {
    throw new Error("Not logged in.");
  }
  return url;
}

/** Runs a SOQL query via the REST Query API. Returns the parsed records array. */
async function runQuery(soql) {
  const url = `${getInstanceUrl()}/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`;
  const response = await fetch(url, { headers: getAuthHeaders() });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Query failed: ${response.status} ${errText}`);
  }
  const data = await response.json();
  return data.records || [];
}

/**
 * Inserts one sObject record. Pass allowDuplicates=true to include the
 * Sforce-Duplicate-Rule-Header (needed for new Account creation, since
 * the org's Standard_Account_Duplicate_Rule would otherwise block a
 * legitimate new-address insert that happens to resemble an existing one).
 */
async function insertRecord(sobjectType, fields, allowDuplicates) {
  const url = `${getInstanceUrl()}/services/data/${SF_API_VERSION}/sobjects/${sobjectType}`;
  const headers = getAuthHeaders();
  if (allowDuplicates) {
    headers["Sforce-Duplicate-Rule-Header"] = "allowSave=true";
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(fields),
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Insert into ${sobjectType} failed: ${response.status} ${errText}`);
  }
  const data = await response.json();
  return data.id;
}

/** Inserts multiple records of the same type via the sObject Collections API (up to 200 per call). */
async function insertCollection(sobjectType, recordsFields) {
  const url = `${getInstanceUrl()}/services/data/${SF_API_VERSION}/composite/sobjects`;
  const records = recordsFields.map((fields) => ({
    attributes: { type: sobjectType },
    ...fields,
  }));
  const response = await fetch(url, {
    method: "POST",
    headers: getAuthHeaders(),
    body: JSON.stringify({ allOrNone: true, records }),
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Collection insert into ${sobjectType} failed: ${response.status} ${errText}`);
  }
  const results = await response.json();
  const failed = results.filter((r) => !r.success);
  if (failed.length > 0) {
    throw new Error(`${failed.length} of ${results.length} ${sobjectType} records failed: ${JSON.stringify(failed)}`);
  }
  return results.map((r) => r.id);
}

window.SalesforceApi = {
  login,
  handleCallback,
  isLoggedIn,
  logout,
  runQuery,
  insertRecord,
  insertCollection,
};
