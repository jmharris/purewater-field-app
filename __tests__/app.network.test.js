/**
 * Tests for the functions that call window.SalesforceApi -- mock that
 * global before requiring app.js so the mocked version is what gets used.
 */
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

let queryCalls;
let insertCalls;
let collectionCalls;
let queryResponses;

function setupMockSalesforceApi() {
  queryCalls = [];
  insertCalls = [];
  collectionCalls = [];
  queryResponses = [];

  global.window = global.window || {};
  global.window.SalesforceApi = {
    runQuery: async (soql) => {
      queryCalls.push(soql);
      return queryResponses.shift() || [];
    },
    insertRecord: async (sobjectType, fields, allowDuplicates) => {
      insertCalls.push({ sobjectType, fields, allowDuplicates });
      return `mock-${sobjectType}-id-${insertCalls.length}`;
    },
    insertCollection: async (sobjectType, recordsFields) => {
      collectionCalls.push({ sobjectType, recordsFields });
      return recordsFields.map((_, i) => `mock-${sobjectType}-${i}`);
    },
  };
}

beforeEach(() => {
  setupMockSalesforceApi();
  delete require.cache[require.resolve("../app.js")];
});

test("findNearbyAccounts: returns results from the first radius that has matches", async () => {
  setupMockSalesforceApi();
  queryResponses = [[], [{ Id: "001a", Name: "Test Home", BillingStreet: "1 Main St", BillingCity: "Edmond", BillingPostalCode: "73025", dist: 0.8 }]];
  const ServiceVisitApp = require("../app.js");

  const results = await ServiceVisitApp.findNearbyAccounts(35.65, -97.48);

  assert.equal(queryCalls.length, 2, "should have widened radius once before finding a match");
  assert.equal(results.length, 1);
  assert.equal(results[0].name, "Test Home");
  assert.equal(results[0].distanceMiles, 0.8);
});

test("findNearbyAccounts: returns empty array when all radii come up empty", async () => {
  setupMockSalesforceApi();
  queryResponses = [[], [], []];
  const ServiceVisitApp = require("../app.js");

  const results = await ServiceVisitApp.findNearbyAccounts(35.65, -97.48);

  assert.equal(queryCalls.length, 3, "should try every configured radius");
  assert.equal(results.length, 0);
});

test("findNearbyAccounts: queries only Merge_Status__c = 'Active' accounts", async () => {
  setupMockSalesforceApi();
  queryResponses = [[{ Id: "001a", Name: "X", dist: 0.1 }]];
  const ServiceVisitApp = require("../app.js");

  await ServiceVisitApp.findNearbyAccounts(35.65, -97.48);

  assert.match(queryCalls[0], /Merge_Status__c = 'Active'/);
});

test("searchAccounts: blank search term returns empty without querying", async () => {
  setupMockSalesforceApi();
  const ServiceVisitApp = require("../app.js");

  const results = await ServiceVisitApp.searchAccounts("   ");

  assert.equal(results.length, 0);
  assert.equal(queryCalls.length, 0);
});

test("searchAccounts: escapes single quotes in the search term", async () => {
  setupMockSalesforceApi();
  queryResponses = [[]];
  const ServiceVisitApp = require("../app.js");

  await ServiceVisitApp.searchAccounts("O'Brien");

  assert.match(queryCalls[0], /O\\'Brien/);
});

test("getServiceCatalog: maps PricebookEntry records into a flat catalog shape", async () => {
  setupMockSalesforceApi();
  queryResponses = [
    [{ Id: "01u1", Product2Id: "01t1", UnitPrice: 60, Product2: { Name: "Salt Delivery" } }],
  ];
  const ServiceVisitApp = require("../app.js");

  const catalog = await ServiceVisitApp.getServiceCatalog();

  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].name, "Salt Delivery");
  assert.equal(catalog[0].pricebookEntryId, "01u1");
  assert.equal(catalog[0].unitPrice, 60);
});

test("saveServiceVisit: happy path with existing account and no occupant name", async () => {
  setupMockSalesforceApi();
  const ServiceVisitApp = require("../app.js");

  const result = await ServiceVisitApp.saveServiceVisit({
    selectedAccountId: "001existing",
    lineItems: [{ pricebookEntryId: "01uxxx", quantity: 1, unitPrice: 60 }],
  });

  assert.equal(result.accountId, "001existing");
  assert.equal(result.contactId, null);
  assert.ok(result.opportunityId);

  const oppInsert = insertCalls.find((c) => c.sobjectType === "Opportunity");
  assert.ok(oppInsert, "should insert an Opportunity");
  assert.equal(oppInsert.fields.StageName, "Closed Won");
  assert.equal("Amount" in oppInsert.fields, false, "must never set Amount directly");

  assert.equal(collectionCalls.length, 1);
  assert.equal(collectionCalls[0].sobjectType, "OpportunityLineItem");
});

test("saveServiceVisit: creates a new Account with the duplicate-rule bypass flag", async () => {
  setupMockSalesforceApi();
  const ServiceVisitApp = require("../app.js");

  await ServiceVisitApp.saveServiceVisit({
    newAccountStreet: "42 New Ln",
    newAccountCity: "Edmond",
    lineItems: [{ pricebookEntryId: "01uxxx", quantity: 1, unitPrice: 60 }],
  });

  const acctInsert = insertCalls.find((c) => c.sobjectType === "Account");
  assert.ok(acctInsert);
  assert.equal(acctInsert.allowDuplicates, true);
  assert.equal(acctInsert.fields.BillingStateCode, "OK");
  assert.equal(acctInsert.fields.BillingCountryCode, "US");
});

test("saveServiceVisit: reuses an existing Contact found by name+Account instead of creating a new one", async () => {
  setupMockSalesforceApi();
  queryResponses = [[{ Id: "003existing" }]]; // findExistingContact's query
  const ServiceVisitApp = require("../app.js");

  const result = await ServiceVisitApp.saveServiceVisit({
    selectedAccountId: "001existing",
    occupantName: "Jane Smith",
    lineItems: [{ pricebookEntryId: "01uxxx", quantity: 1, unitPrice: 60 }],
  });

  assert.equal(result.contactId, "003existing");
  const contactInsert = insertCalls.find((c) => c.sobjectType === "Contact");
  assert.equal(contactInsert, undefined, "must not insert a new Contact when one already matched");
});

test("saveServiceVisit: creates a new Contact when no existing match is found", async () => {
  setupMockSalesforceApi();
  queryResponses = [[]]; // findExistingContact's query returns no match
  const ServiceVisitApp = require("../app.js");

  const result = await ServiceVisitApp.saveServiceVisit({
    selectedAccountId: "001existing",
    occupantName: "New Person",
    lineItems: [{ pricebookEntryId: "01uxxx", quantity: 1, unitPrice: 60 }],
  });

  assert.ok(result.contactId);
  const contactInsert = insertCalls.find((c) => c.sobjectType === "Contact");
  assert.ok(contactInsert);
  assert.equal(contactInsert.fields.LastName, "Person");
  assert.equal(contactInsert.fields.FirstName, "New");
});

test("saveServiceVisit: rejects when validation fails, before any API calls", async () => {
  setupMockSalesforceApi();
  const ServiceVisitApp = require("../app.js");

  await assert.rejects(
    () => ServiceVisitApp.saveServiceVisit({ lineItems: [] }),
    /Select an existing address|Select at least one product/
  );
  assert.equal(insertCalls.length, 0);
  assert.equal(collectionCalls.length, 0);
});
