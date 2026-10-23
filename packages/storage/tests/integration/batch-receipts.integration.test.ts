import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ProjectDatabaseFixture,
  createDocument,
  expectRelayError,
} from "./helpers/project-database-fixture";

const receipt = {
  operationKey: "publish",
  requestJson: '{"actor":"agent","input":{"version":1}}',
  resultJson: '{"status":"committed"}',
};
let fixture: ProjectDatabaseFixture;

beforeEach(() => {
  fixture = new ProjectDatabaseFixture("batch-receipts");
});

afterEach(() => {
  fixture.close();
});

describe("Журнал квитанций SQLite", () => {
  test("отказ внешней транзакции откатывает данные и квитанцию вместе", () => {
    const db = fixture.create();
    const document = createDocument();
    const generation = db.getGeneration();

    expect(() =>
      db.transaction(() => {
        db.insert(document);
        db.insertBatchReceipt(receipt);
        throw new Error("Отказ после обеих записей");
      }),
    ).toThrow("Отказ после обеих записей");

    expect(db.get(document.id)).toBeUndefined();
    expect(db.getBatchReceipt(receipt.operationKey)).toBeUndefined();
    expect(db.getGeneration()).toBe(generation);
    db.insertBatchReceipt(receipt);
    expect(db.getBatchReceipt(receipt.operationKey)).toEqual(receipt);
  });

  test("ключ уникален после reopen, конфликт квитанции откатывает предшествующую запись", () => {
    const db = fixture.create();
    db.insertBatchReceipt(receipt);
    const generation = db.getGeneration();
    db.close();
    const reopened = fixture.open();
    const document = createDocument();

    expectRelayError(
      () =>
        reopened.transaction(() => {
          reopened.insert(document);
          reopened.insertBatchReceipt({ ...receipt, resultJson: '{"different":true}' });
        }),
      "CONFLICT",
    );

    expect(reopened.getBatchReceipt(receipt.operationKey)).toEqual(receipt);
    expect(reopened.get(document.id)).toBeUndefined();
    expect(reopened.getGeneration()).toBe(generation);
    fixture.withRaw((raw) => {
      expect(() => raw.exec("UPDATE batch_receipts SET result_json = '{}' ")).toThrow();
      expect(() => raw.exec("DELETE FROM batch_receipts")).toThrow();
    });
  });
});
