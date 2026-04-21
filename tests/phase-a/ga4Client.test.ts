// tests/phase-a/ga4Client.test.ts
import { checkGa4Connection, _resetClientForTest } from "../../src/lib/ga4/ga4Client";

jest.mock("@google-analytics/data", () => ({
  BetaAnalyticsDataClient: jest.fn().mockImplementation(() => ({
    runReport: jest.fn(),
  })),
}));

import { BetaAnalyticsDataClient } from "@google-analytics/data";

const MockedClient = BetaAnalyticsDataClient as jest.MockedClass<typeof BetaAnalyticsDataClient>;

describe("checkGa4Connection", () => {
  beforeEach(() => {
    _resetClientForTest();
    MockedClient.mockClear();
  });

  afterEach(() => {
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  });

  it("returns not_configured when credentials env is missing", async () => {
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    const result = await checkGa4Connection("123456789");
    expect(result.status).toBe("not_configured");
  });

  it("returns ok when runReport succeeds", async () => {
    const creds = { type: "service_account", project_id: "test", private_key: "k", client_email: "e@test.iam.gserviceaccount.com" };
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = Buffer.from(JSON.stringify(creds)).toString("base64");

    const mockRunReport = jest.fn().mockResolvedValue([{ rows: [] }]);
    MockedClient.mockImplementation(() => ({ runReport: mockRunReport } as unknown as BetaAnalyticsDataClient));

    const result = await checkGa4Connection("123456789");
    expect(result.status).toBe("ok");
    expect(mockRunReport).toHaveBeenCalledWith(expect.objectContaining({
      property: "properties/123456789",
    }));
  });

  it("returns error with permission_denied for 403 error", async () => {
    const creds = { type: "service_account" };
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = Buffer.from(JSON.stringify(creds)).toString("base64");

    const mockRunReport = jest.fn().mockRejectedValue(new Error("PERMISSION_DENIED: Access denied"));
    MockedClient.mockImplementation(() => ({ runReport: mockRunReport } as unknown as BetaAnalyticsDataClient));

    const result = await checkGa4Connection("123456789");
    expect(result.status).toBe("error");
    expect(result.error).toBe("permission_denied");
  });

  it("returns error with property_not_found for 404 error", async () => {
    const creds = { type: "service_account" };
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = Buffer.from(JSON.stringify(creds)).toString("base64");

    const mockRunReport = jest.fn().mockRejectedValue(new Error("NOT_FOUND: Property not found"));
    MockedClient.mockImplementation(() => ({ runReport: mockRunReport } as unknown as BetaAnalyticsDataClient));

    const result = await checkGa4Connection("999999999");
    expect(result.status).toBe("error");
    expect(result.error).toBe("property_not_found");
  });
});
