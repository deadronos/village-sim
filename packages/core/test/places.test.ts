import { describe, expect, it } from "vitest";
import { VILLAGE_PLACES, findRoute, getEdgeCost } from "../src/index.ts";

describe("Village place graph", () => {
  it("connects every pair of village places with valid shortest paths", () => {
    for (const from of VILLAGE_PLACES) {
      for (const to of VILLAGE_PLACES) {
        const plan = findRoute(from.id, to.id);
        if (from.id === to.id) {
          expect(plan.hops).toEqual([]);
          expect(plan.totalCost).toBe(0);
        } else {
          expect(plan.hops.length).toBeGreaterThan(0);
          expect(plan.hops[plan.hops.length - 1]).toBe(to.id);
          // Verify edge sum equals totalCost
          let sum = 0;
          let prev = from.id;
          for (const hop of plan.hops) {
            sum += getEdgeCost(prev, hop);
            prev = hop;
          }
          expect(sum).toBe(plan.totalCost);
        }
      }
    }
  });

  it("computes multi-hop paths between distant workplaces", () => {
    const plan = findRoute("fields", "woods");
    expect(plan.hops.length).toBeGreaterThanOrEqual(3);
    expect(plan.hops[plan.hops.length - 1]).toBe("woods");
  });
});
