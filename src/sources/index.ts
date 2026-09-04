/** Adapters that turn each museum's API into one normalised record shape. */

import type { RawObject } from "./base.ts";
import * as aic from "./aic.ts";
import * as met from "./met.ts";
import * as rijksmuseum from "./rijksmuseum.ts";
import * as wellcome from "./wellcome.ts";

export interface Adapter {
  harvest(
    windows: ReadonlyArray<readonly [number, number]>,
    perWindow: number,
  ): AsyncGenerator<RawObject>;
}

export const ADAPTERS: Record<string, Adapter> = { met, aic, wellcome, rijksmuseum };
export { aic, met, rijksmuseum, wellcome };
