import { describe, expect, test } from "bun:test";
import { availableProvisionalKey, indexKeyAddresses } from "./key-collisions";

const largeKeys = [
  {
    name: "суффикс за пределом точности Number",
    key: "DOC-9007199254740992",
    occupied: "DOC-9007199254740993",
    expected: "DOC-9007199254740994",
  },
  {
    name: "перенос десятичного разряда",
    key: "DOC-999999999999999999999999999999",
    occupied: "DOC-1000000000000000000000000000000",
    expected: "DOC-1000000000000000000000000000001",
  },
] as const;

describe("Свободные предложения читаемых ключей", () => {
  test.each(largeKeys)("$name сохраняет точный следующий номер", ({ key, occupied, expected }) => {
    const addresses = new Map<string, string>([
      [key, "winner"],
      [occupied, "reserved"],
    ]);

    const proposal = availableProvisionalKey(key, addresses, new Set());

    expect(proposal).toBe(expected);
    expect(addresses.has(expected)).toBe(false);
  });

  test("индекс сохраняет обоих владельцев коллизии и пропускает адреса и предложения данного чтения", () => {
    const index = indexKeyAddresses(
      {
        addresses: [
          { ref: "TASK-42", entityId: "local" },
          { ref: "TASK-43", entityId: "alias" },
        ],
      },
      { addresses: [{ ref: "TASK-42", entityId: "accepted" }] },
      [{ entityId: "pending", key: "TASK-44" }],
    );

    const proposal = availableProvisionalKey("TASK-42", index.occupied, new Set(["TASK-45"]));

    expect(index.accepted.get("TASK-42")).toBe("accepted");
    expect(index.occupied.get("TASK-42")).toEqual(new Set(["local", "accepted"]));
    expect(proposal).toBe("TASK-46");
    expect(index.occupied.has(proposal)).toBe(false);
  });
});
