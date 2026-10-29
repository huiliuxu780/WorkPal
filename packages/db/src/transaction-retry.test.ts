import { describe, expect, it, vi } from "vitest";
import { withTransactionRetry } from "./transaction-retry.js";

function databaseConflict(originalCode: "40001" | "40P01") {
  return Object.assign(new Error(originalCode), {
    code: "P2010",
    meta: { driverAdapterError: { cause: { originalCode } } },
  });
}

describe("withTransactionRetry", () => {
  it.each(["40001", "40P01"] as const)("retries SQLSTATE %s", async (code) => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(databaseConflict(code))
      .mockResolvedValueOnce("ok");

    await expect(withTransactionRetry(operation)).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("retries a Prisma write conflict", async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("write conflict"), { code: "P2034" }))
      .mockResolvedValueOnce("ok");

    await expect(withTransactionRetry(operation)).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("caps retries at three attempts", async () => {
    const operation = vi.fn().mockRejectedValue(databaseConflict("40P01"));

    await expect(withTransactionRetry(operation)).rejects.toMatchObject({ code: "P2010" });
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("does not retry unrelated database errors", async () => {
    const operation = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));

    await expect(withTransactionRetry(operation)).rejects.toMatchObject({ code: "P2002" });
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
