// SPDX-License-Identifier: Apache-2.0
// Ambient types for the untyped dom-anchor-* packages (SPEC §6).
//
// Shapes follow each package's documented API. They are declared here rather
// than depended on from a types package because both libraries are small,
// stable, and have no published typings.

declare module "dom-anchor-text-position" {
  export interface TextPositionSelector {
    start: number;
    end: number;
  }
  export function fromRange(root: Node, range: Range): TextPositionSelector;
  export function toRange(
    root: Node,
    selector: { start?: number; end?: number },
  ): Range;
}

declare module "dom-anchor-text-quote" {
  export interface TextQuoteSelector {
    exact: string;
    prefix?: string;
    suffix?: string;
  }
  export interface TextPositionSelector {
    start: number;
    end: number;
  }
  export interface ToRangeOptions {
    /** A position to prefer when the quote appears more than once. */
    hint?: number;
  }
  export function fromRange(root: Node, range: Range): TextQuoteSelector;
  export function fromTextPosition(
    root: Node,
    selector: TextPositionSelector,
  ): TextQuoteSelector;
  export function toRange(
    root: Node,
    selector: TextQuoteSelector,
    options?: ToRangeOptions,
  ): Range | null;
  export function toTextPosition(
    root: Node,
    selector: TextQuoteSelector,
    options?: ToRangeOptions,
  ): TextPositionSelector | null;
}
