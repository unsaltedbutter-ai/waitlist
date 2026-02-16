import { describe, it, expect } from "vitest";
import {
  getInitialServices,
  computeServiceCreditCents,
  formatInitialServicesLabel,
  type QueueEntry,
} from "../onboarding-pricing";

const netflix: QueueEntry = { serviceId: "netflix", groupLabel: "Netflix", priceCents: 1599 };
const hulu: QueueEntry = { serviceId: "hulu", groupLabel: "Hulu", priceCents: 999 };
const disney: QueueEntry = { serviceId: "disney", groupLabel: "Disney+", priceCents: 1399 };

describe("getInitialServices", () => {
  it("returns 1 service for solo", () => {
    const result = getInitialServices([netflix, hulu, disney], "solo");
    expect(result).toEqual([netflix]);
  });

  it("returns 2 services for duo", () => {
    const result = getInitialServices([netflix, hulu, disney], "duo");
    expect(result).toEqual([netflix, hulu]);
  });

  it("returns all available if queue shorter than slot count", () => {
    const result = getInitialServices([netflix], "duo");
    expect(result).toEqual([netflix]);
  });

  it("returns empty for empty queue", () => {
    expect(getInitialServices([], "solo")).toEqual([]);
    expect(getInitialServices([], "duo")).toEqual([]);
  });
});

describe("computeServiceCreditCents", () => {
  it("sums 1 service for solo", () => {
    expect(computeServiceCreditCents([netflix, hulu], "solo")).toBe(1599);
  });

  it("sums 2 services for duo", () => {
    expect(computeServiceCreditCents([netflix, hulu], "duo")).toBe(1599 + 999);
  });

  it("returns 0 for empty queue", () => {
    expect(computeServiceCreditCents([], "duo")).toBe(0);
  });

  it("respects queue order (duo takes first two)", () => {
    expect(computeServiceCreditCents([hulu, disney, netflix], "duo")).toBe(999 + 1399);
  });
});

describe("formatInitialServicesLabel", () => {
  it("solo with services shows single name", () => {
    expect(formatInitialServicesLabel([netflix, hulu], "solo")).toBe("Netflix");
  });

  it("duo with services shows both names joined", () => {
    expect(formatInitialServicesLabel([netflix, hulu], "duo")).toBe("Netflix and Hulu");
  });

  it("empty queue returns fallback", () => {
    expect(formatInitialServicesLabel([], "solo")).toBe("your first service");
    expect(formatInitialServicesLabel([], "duo")).toBe("your first service");
  });

  it("duo with only 1 service shows single name", () => {
    expect(formatInitialServicesLabel([disney], "duo")).toBe("Disney+");
  });
});
