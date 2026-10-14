// SPDX-License-Identifier: Apache-2.0
// Worker actor for the barrier self-test: prepares for a different time each, then reports when it fired (SPEC §12).

export async function prepare(arg) {
  await new Promise((r) => setTimeout(r, arg.prepareMs));
  return { preparedAt: performance.timeOrigin + performance.now() };
}

export async function fire(arg, state, { firedAt }) {
  return { i: arg.i, preparedAt: state.preparedAt, firedAt };
}
