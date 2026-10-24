import { describe, expect, test } from "bun:test";
import type { EntityRecord } from "@relay/contracts";
import {
  portableAggregateVersion,
  portableEntity,
  canonicalJson,
  replicationFingerprint,
} from "./portable-version";
import { versionComponent } from "../components/component-store";

const owner: EntityRecord = {
  id: "task",
  kind: "task",
  key: "PRODUCT-1",
  revision: 4,
  createdAt: "2026-10-24T00:00:00.000Z",
  updatedAt: "2026-10-24T00:00:00.000Z",
  createdBy: "author",
  updatedBy: "author",
  data: { title: "Владелец", historical: { revision: 77, key: "DOC-OLD" } },
};

describe("Переносимые версии owner и aggregate", () => {
  test("shallow frozen wrapper и getter не маскируют изменение hash payload", () => {
    const child = { body: "До" };
    const shallow = Object.freeze({ child });
    let value = "Первый";
    const getter = Object.freeze({
      get body(): string {
        return value;
      },
    });
    const first = replicationFingerprint(shallow);
    const firstGetter = canonicalJson(getter);

    child.body = "После";
    value = "Второй";

    expect(replicationFingerprint(shallow)).not.toBe(first);
    expect(canonicalJson(shallow)).toBe('{"child":{"body":"После"}}');
    expect(canonicalJson(getter)).not.toBe(firstGetter);
    expect(canonicalJson(getter)).toBe('{"body":"Второй"}');
  });

  test("CAS исключается только сверху, исторические numeric revisions остаются точными", () => {
    const first = portableEntity(owner);
    const imported = portableEntity({ ...owner, revision: 900 });

    expect(imported).toEqual(first);
    expect(first.record).not.toHaveProperty("revision");
    expect(first.record.data.historical).toEqual({ revision: 77, key: "DOC-OLD" });
  });

  test("разные child effects при одинаковых raw owner/time/actor получают разные aggregate guards", () => {
    const record = portableEntity(owner);
    const first = versionComponent({
      id: "first",
      ownerId: owner.id,
      kind: "task-criterion",
      position: "V",
      parents: [],
      deleted: false,
      value: {
        id: "first",
        title: "Первое",
        summary: "",
        description: "",
        completed: false,
        completedAt: null,
        completedBy: null,
      },
    });
    if (first.kind !== "task-criterion") {
      throw new Error("Неверный вид fixture");
    }
    const second = versionComponent({
      ...first,
      id: "second",
      position: "W",
      value: { ...first.value, id: "second" },
    });
    if (second.kind !== "task-criterion") {
      throw new Error("Неверный вид fixture");
    }
    const changedFirst = versionComponent({
      ...first,
      parents: [first.version],
      value: { ...first.value, title: "Изменено первое" },
    });
    const changedSecond = versionComponent({
      ...second,
      parents: [second.version],
      value: { ...second.value, title: "Изменено второе" },
    });

    const before = portableAggregateVersion(record, [first, second]);
    const left = portableAggregateVersion(record, [changedFirst, second]);
    const right = portableAggregateVersion(record, [first, changedSecond]);

    expect(left).not.toBe(before);
    expect(right).not.toBe(before);
    expect(left).not.toBe(right);
    expect(portableAggregateVersion(record, [second, first])).toBe(before);
    expect(
      portableAggregateVersion(portableEntity({ ...owner, revision: 900 }), [first, second]),
    ).toBe(before);
  });
});
