// SPDX-License-Identifier: Apache-2.0
// The requirement list mirrors the deployment's policy, never a copy of it (SPEC §13).

import { describe, expect, it } from "vitest";
import { allMet, requirementsFrom } from "./passwordPolicy";
import type { PasswordValidationStatus } from "firebase/auth";

/**
 * The failure mode guarded against is a form that lies.
 *
 * If the requirement list were hardcoded, turning a rule off in the Firebase
 * console would leave the browser demanding something the server no longer
 * asks for — and turning one ON would leave a person staring at a green
 * checklist beside a rejected password.
 */
const status = (
  options: Record<string, unknown>,
  flags: Record<string, boolean | undefined>,
) =>
  ({
    isValid: false,
    passwordPolicy: { customStrengthOptions: options },
    ...flags,
  }) as unknown as PasswordValidationStatus;

describe("requirementsFrom", () => {
  it("lists exactly what this deployment enforces", () => {
    const reqs = requirementsFrom(
      status(
        {
          minPasswordLength: 8,
          maxPasswordLength: 4096,
          containsLowercaseLetter: true,
          containsUppercaseLetter: true,
          containsNumericCharacter: true,
          containsNonAlphanumericCharacter: true,
        },
        {
          meetsMinPasswordLength: true,
          meetsMaxPasswordLength: true,
          containsLowercaseLetter: true,
          containsUppercaseLetter: false,
          containsNumericCharacter: true,
          containsNonAlphanumericCharacter: false,
        },
      ),
    );

    expect(reqs.map((r) => r.key)).toEqual(["length", "lower", "upper", "digit", "symbol"]);
    expect(reqs.find((r) => r.key === "length")!.label).toBe("At least 8 characters");
    expect(reqs.find((r) => r.key === "upper")!.met).toBe(false);
    expect(reqs.find((r) => r.key === "digit")!.met).toBe(true);
    expect(allMet(reqs)).toBe(false);
  });

  it("omits a rule the deployment does not ask for", () => {
    // Turning symbols off in the console must remove the line, not leave an
    // unmet requirement nobody can satisfy.
    const reqs = requirementsFrom(
      status(
        { minPasswordLength: 6, containsLowercaseLetter: true },
        { meetsMinPasswordLength: true, containsLowercaseLetter: true },
      ),
    );
    expect(reqs.map((r) => r.key)).toEqual(["length", "lower"]);
    expect(reqs.find((r) => r.key === "length")!.label).toBe("At least 6 characters");
    expect(allMet(reqs)).toBe(true);
  });

  it("treats an absent flag as not-asked-for, never as unmet", () => {
    // `undefined` is what the SDK reports for a disabled rule. Rendering it as
    // a failed requirement would block a password the server accepts.
    const reqs = requirementsFrom(
      status(
        { minPasswordLength: 8 },
        { meetsMinPasswordLength: true, containsUppercaseLetter: undefined },
      ),
    );
    expect(reqs.map((r) => r.key)).toEqual(["length"]);
    expect(allMet(reqs)).toBe(true);
  });

  it("mentions the maximum only once it is actually in the way", () => {
    const within = requirementsFrom(
      status({ minPasswordLength: 8, maxPasswordLength: 4096 }, {
        meetsMinPasswordLength: true,
        meetsMaxPasswordLength: true,
      }),
    );
    expect(within.map((r) => r.key)).not.toContain("max");

    const over = requirementsFrom(
      status({ minPasswordLength: 8, maxPasswordLength: 4096 }, {
        meetsMinPasswordLength: true,
        meetsMaxPasswordLength: false,
      }),
    );
    expect(over.find((r) => r.key === "max")!.met).toBe(false);
  });

  it("is not satisfied by an empty policy", () => {
    // A policy that failed to load must not read as "everything is fine".
    expect(allMet(requirementsFrom(status({}, {})))).toBe(false);
  });
});
