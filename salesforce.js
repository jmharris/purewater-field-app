/**
 * Thin Salesforce API wrapper: OAuth 2.0 Web Server Flow with PKCE
 * (no client secret -- this is a public, browser-only client), plus
 * REST/Query API helpers used by the rest of the app.
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
  codeVerifier: "sf_pkce_code_verifier",
};

function base64UrlEncode(buffer) {
  const bytes = new Uint8Array(buffer);
  let str = "";
  for (const b of bytes) {
    str += String.fromCharCode(b);
  }
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generateCodeVerifier() {
  const array = new Uint8Array(64);
  crypto.getRandomValues(array);
  return base64UrlEncode(array.buffer);
}

async function generateCodeChallenge(verifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(digest);
}

/** Kicks off login: redirects the browser to Salesforce's authorize page. */
async function login() {
  const codeVerifier = generateCodeVerifier();
  sessionStorage.setItem(STORAGE_KEYS.codeVerifier, codeVerifier);
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: SF_CLIENT_ID,
    redirect_uri: getRedirectUri(),
    scope: "api refresh_token",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  window.location.href = `${SF_LOGIN_HOST}/services/oauth2/authorize?${params.toString()}`;
}

/**
 * Called from callback.html after Salesforce redirects back with ?code=...
 * Exchanges the authorization code for an access token.
 */
async function handleCallback() {
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get("code");
  const error = urlParams.get("error");

  if (error) {
    throw new Error(`OAuth error: ${error} - ${urlParams.get("error_description") || ""}`);
  }
  if (!code) {
    throw new Error("No authorization code returned from Salesforce.");
  }

  const codeVerifier = sessionStorage.getItem(STORAGE_KEYS.codeVerifier);
  if (!codeVerifier) {
    throw new Error("Missing PKCE code verifier -- login must be restarted.");
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: code,
    client_id: SF_CLIENT_ID,
    redirect_uri: getRedirectUri(),
    code_verifier: codeVerifier,
  });

  const response = await fetch(`${SF_LOGIN_HOST}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${errText}`);
  }

  const tokenData = await response.json();
  sessionStorage.setItem(STORAGE_KEYS.accessToken, tokenData.access_token);
  sessionStorage.setItem(STORAGE_KEYS.instanceUrl, tokenData.instance_url);
  sessionStorage.removeItem(STORAGE_KEYS.codeVerifier);
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
