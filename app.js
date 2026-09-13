/**
 * Domain logic for the Service Visit Entry app: Account matching
 * (geolocation + text search), catalog lookup, name-splitting for
 * Contact creation, and the multi-step save flow. Pure/testable
 * functions are kept separate from DOM wiring so they can be unit
 * tested without a browser.
 */

const NEW_VISIT_STAGE = "Closed Won";
const SEARCH_RADII_MILES = [0.25, 1, 2];

/**
 * Splits a free-text occupant name into First/Last for Contact creation.
 * Contact requires LastName; a single-word name (or one with no space)
 * goes entirely into LastName rather than being dropped.
 */
function splitOccupantName(fullName) {
  const trimmed = (fullName || "").trim();
  if (!trimmed) {
    return { firstName: null, lastName: null };
  }
  const lastSpace = trimmed.lastIndexOf(" ");
  if (lastSpace > 0) {
    return {
      firstName: trimmed.substring(0, lastSpace).trim(),
      lastName: trimmed.substring(lastSpace + 1).trim(),
    };
  }
  return { firstName: null, lastName: trimmed };
}

function escapeSoqlString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Finds nearby Accounts, widening the search radius through
 * SEARCH_RADII_MILES until a radius returns at least one result (or all
 * radii are exhausted). Never auto-selects -- returns a candidate list
 * for the UI to show for confirmation.
 */
async function findNearbyAccounts(latitude, longitude) {
  for (const radius of SEARCH_RADII_MILES) {
    const soql =
      `SELECT Id, Name, BillingStreet, BillingCity, BillingPostalCode, ` +
      `DISTANCE(BillingAddress, GEOLOCATION(${latitude},${longitude}), 'mi') dist ` +
      `FROM Account ` +
      `WHERE Merge_Status__c = 'Active' ` +
      `AND DISTANCE(BillingAddress, GEOLOCATION(${latitude},${longitude}), 'mi') < ${radius} ` +
      `ORDER BY DISTANCE(BillingAddress, GEOLOCATION(${latitude},${longitude}), 'mi') ASC ` +
      `LIMIT 10`;
    const records = await window.SalesforceApi.runQuery(soql);
    if (records.length > 0) {
      return records.map((r) => ({
        accountId: r.Id,
        name: r.Name,
        street: r.BillingStreet,
        city: r.BillingCity,
        postalCode: r.BillingPostalCode,
        distanceMiles: r.dist,
      }));
    }
  }
  return [];
}

/** Text search fallback for no-signal or address-not-in-system cases. */
async function searchAccounts(searchTerm) {
  const term = (searchTerm || "").trim();
  if (!term) {
    return [];
  }
  const escaped = escapeSoqlString(term);
  const soql =
    `SELECT Id, Name, BillingStreet, BillingCity, BillingPostalCode ` +
    `FROM Account ` +
    `WHERE Merge_Status__c = 'Active' ` +
    `AND (Name LIKE '%${escaped}%' OR BillingStreet LIKE '%${escaped}%') ` +
    `ORDER BY Name LIMIT 20`;
  const records = await window.SalesforceApi.runQuery(soql);
  return records.map((r) => ({
    accountId: r.Id,
    name: r.Name,
    street: r.BillingStreet,
    city: r.BillingCity,
    postalCode: r.BillingPostalCode,
    distanceMiles: null,
  }));
}

/** Active Product2 + Standard Price Book PricebookEntry, for the product picker. */
async function getServiceCatalog() {
  const soql =
    `SELECT Id, UnitPrice, Product2Id, Product2.Name ` +
    `FROM PricebookEntry ` +
    `WHERE IsActive = true AND Pricebook2.IsStandard = true AND Product2.IsActive = true ` +
    `ORDER BY Product2.Name`;
  const records = await window.SalesforceApi.runQuery(soql);
  return records.map((r) => ({
    productId: r.Product2Id,
    pricebookEntryId: r.Id,
    name: r.Product2.Name,
    unitPrice: r.UnitPrice,
  }));
}

/** Sum of quantity*unitPrice across selected line items. */
function calculateTotal(lineItems) {
  return lineItems.reduce((sum, li) => sum + (li.quantity || 0) * (li.unitPrice || 0), 0);
}

/**
 * Validates a visit before allowing submit. Returns an array of error
 * strings (empty array = valid).
 */
function validateVisit(state) {
  const errors = [];
  const hasExistingAccount = Boolean(state.selectedAccountId);
  const hasNewAccountInfo = Boolean(state.newAccountStreet && state.newAccountCity);
  if (!hasExistingAccount && !hasNewAccountInfo) {
    errors.push("Select an existing address or enter a new one.");
  }
  if (!state.lineItems || state.lineItems.length === 0) {
    errors.push("Select at least one product or service.");
  }
  return errors;
}

/**
 * Finds an existing Contact by (LastName, FirstName, AccountId) to avoid
 * creating a duplicate for a repeat visit to the same address.
 */
async function findExistingContact(accountId, firstName, lastName) {
  const escapedLast = escapeSoqlString(lastName);
  let soql =
    `SELECT Id FROM Contact WHERE AccountId = '${accountId}' AND LastName = '${escapedLast}' `;
  if (firstName) {
    soql += `AND FirstName = '${escapeSoqlString(firstName)}' `;
  } else {
    soql += `AND FirstName = null `;
  }
  soql += "LIMIT 1";
  const records = await window.SalesforceApi.runQuery(soql);
  return records.length > 0 ? records[0].Id : null;
}

/**
 * Saves a complete service visit: resolves/creates the Account,
 * resolves/creates the occupant Contact, inserts the Opportunity
 * (Amount is never set directly -- it derives from the
 * OpportunityLineItems inserted after, same convention the historical
 * migration and its bug-fix established), links the Contact via
 * OpportunityContactRole, and inserts the line items.
 *
 * state: {
 *   selectedAccountId, newAccountName, newAccountStreet, newAccountCity,
 *   newAccountPostalCode, occupantName, notes,
 *   lineItems: [{ pricebookEntryId, quantity, unitPrice }]
 * }
 */
async function saveServiceVisit(state) {
  const errors = validateVisit(state);
  if (errors.length > 0) {
    throw new Error(errors.join(" "));
  }

  let accountId = state.selectedAccountId;
  if (!accountId) {
    accountId = await window.SalesforceApi.insertRecord(
      "Account",
      {
        Name: state.newAccountName || `${state.newAccountStreet}, ${state.newAccountCity}`,
        BillingStreet: state.newAccountStreet,
        BillingCity: state.newAccountCity,
        BillingPostalCode: state.newAccountPostalCode || null,
        BillingStateCode: "OK",
        BillingCountryCode: "US",
        Merge_Status__c: "Active",
      },
      true // allow duplicates -- a new address may legitimately resemble an existing one
    );
  }

  let contactId = null;
  const trimmedOccupant = (state.occupantName || "").trim();
  if (trimmedOccupant) {
    const { firstName, lastName } = splitOccupantName(trimmedOccupant);
    contactId = await findExistingContact(accountId, firstName, lastName);
    if (!contactId) {
      contactId = await window.SalesforceApi.insertRecord("Contact", {
        AccountId: accountId,
        FirstName: firstName,
        LastName: lastName,
      });
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const opportunityId = await window.SalesforceApi.insertRecord("Opportunity", {
    AccountId: accountId,
    Name: `Service Visit - ${today}`,
    StageName: NEW_VISIT_STAGE,
    CloseDate: today,
    Description: state.notes || null,
    // Amount is intentionally omitted -- it derives from OpportunityLineItems.
  });

  if (contactId) {
    await window.SalesforceApi.insertRecord("OpportunityContactRole", {
      OpportunityId: opportunityId,
      ContactId: contactId,
      IsPrimary: true,
    });
  }

  await window.SalesforceApi.insertCollection(
    "OpportunityLineItem",
    state.lineItems.map((li) => ({
      OpportunityId: opportunityId,
      PricebookEntryId: li.pricebookEntryId,
      Quantity: li.quantity || 1,
      UnitPrice: li.unitPrice || 0,
    }))
  );

  return { accountId, contactId, opportunityId };
}

const ServiceVisitApp = {
  splitOccupantName,
  findNearbyAccounts,
  searchAccounts,
  getServiceCatalog,
  calculateTotal,
  validateVisit,
  findExistingContact,
  saveServiceVisit,
  SEARCH_RADII_MILES,
};

if (typeof window !== "undefined") {
  window.ServiceVisitApp = ServiceVisitApp;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = ServiceVisitApp;
}
