const { test } = require("node:test");
const assert = require("node:assert/strict");
const ServiceVisitApp = require("../app.js");

test("splitOccupantName: two-word name splits on last space", () => {
  const result = ServiceVisitApp.splitOccupantName("Jane Smith");
  assert.equal(result.firstName, "Jane");
  assert.equal(result.lastName, "Smith");
});

test("splitOccupantName: multi-word name splits on the LAST space", () => {
  const result = ServiceVisitApp.splitOccupantName("Mary Jane Lauderdale");
  assert.equal(result.firstName, "Mary Jane");
  assert.equal(result.lastName, "Lauderdale");
});

test("splitOccupantName: single word goes entirely to lastName", () => {
  const result = ServiceVisitApp.splitOccupantName("Cher");
  assert.equal(result.firstName, null);
  assert.equal(result.lastName, "Cher");
});

test("splitOccupantName: blank/whitespace-only input returns nulls", () => {
  const result = ServiceVisitApp.splitOccupantName("   ");
  assert.equal(result.firstName, null);
  assert.equal(result.lastName, null);
});

test("splitOccupantName: trims surrounding whitespace", () => {
  const result = ServiceVisitApp.splitOccupantName("  John Doe  ");
  assert.equal(result.firstName, "John");
  assert.equal(result.lastName, "Doe");
});

test("calculateTotal: sums quantity * unitPrice across line items", () => {
  const total = ServiceVisitApp.calculateTotal([
    { quantity: 2, unitPrice: 50 },
    { quantity: 1, unitPrice: 25.5 },
  ]);
  assert.equal(total, 125.5);
});

test("calculateTotal: empty line items returns 0", () => {
  assert.equal(ServiceVisitApp.calculateTotal([]), 0);
});

test("calculateTotal: missing quantity/unitPrice treated as 0, not NaN", () => {
  const total = ServiceVisitApp.calculateTotal([{ quantity: null, unitPrice: 50 }]);
  assert.equal(total, 0);
});

test("validateVisit: rejects when no account and no product selected", () => {
  const errors = ServiceVisitApp.validateVisit({ lineItems: [] });
  assert.equal(errors.length, 2);
});

test("validateVisit: passes with an existing account and one line item", () => {
  const errors = ServiceVisitApp.validateVisit({
    selectedAccountId: "001xxx",
    lineItems: [{ pricebookEntryId: "01uxxx", quantity: 1, unitPrice: 60 }],
  });
  assert.equal(errors.length, 0);
});

test("validateVisit: passes with a new-account street+city instead of a selected account", () => {
  const errors = ServiceVisitApp.validateVisit({
    newAccountStreet: "123 Main St",
    newAccountCity: "Edmond",
    lineItems: [{ pricebookEntryId: "01uxxx", quantity: 1, unitPrice: 60 }],
  });
  assert.equal(errors.length, 0);
});

test("validateVisit: rejects a new account with street but no city", () => {
  const errors = ServiceVisitApp.validateVisit({
    newAccountStreet: "123 Main St",
    lineItems: [{ pricebookEntryId: "01uxxx", quantity: 1, unitPrice: 60 }],
  });
  assert.equal(errors.length, 1);
});

test("SEARCH_RADII_MILES: widening sequence is ascending", () => {
  const radii = ServiceVisitApp.SEARCH_RADII_MILES;
  for (let i = 1; i < radii.length; i++) {
    assert.ok(radii[i] > radii[i - 1], "radii must strictly increase");
  }
});
