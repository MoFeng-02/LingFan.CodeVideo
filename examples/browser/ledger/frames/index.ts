/** 三十一个 fn，按章分组：每段一个函数，可单独拿来算它的帧。 */
import type { StepContext } from "@lingfan-video/contracts";
import { K01 } from "./c1/K01";
import { K02 } from "./c1/K02";
import { K03 } from "./c1/K03";
import { K04 } from "./c1/K04";
import { K05 } from "./c1/K05";
import { K06 } from "./c1/K06";
import { K07 } from "./c1/K07";
import { K08 } from "./c1/K08";
import { K09 } from "./c2/K09";
import { K10 } from "./c2/K10";
import { K11 } from "./c2/K11";
import { K12 } from "./c2/K12";
import { K13 } from "./c2/K13";
import { K14 } from "./c2/K14";
import { K15 } from "./c2/K15";
import { K16 } from "./c2/K16";
import { K17 } from "./c2/K17";
import { K18 } from "./c2/K18";
import { K19 } from "./c2/K19";
import { K20 } from "./c2/K20";
import { K21 } from "./c3/K21";
import { K22 } from "./c3/K22";
import { K23 } from "./c3/K23";
import { K24 } from "./c3/K24";
import { K25 } from "./c3/K25";
import { K26 } from "./c3/K26";
import { K27 } from "./c3/K27";
import { K28 } from "./c3/K28";
import { K29 } from "./c3/K29";
import { K30 } from "./c3/K30";
import { K31 } from "./c3/K31";

import type { LedgerState } from "./frame";

export const FRAMES: readonly (readonly ((
  ctx: StepContext,
) => LedgerState)[])[] = [
  [K01, K02, K03, K04, K05, K06, K07, K08],
  [K09, K10, K11, K12, K13, K14, K15, K16, K17, K18, K19, K20],
  [K21, K22, K23, K24, K25, K26, K27, K28, K29, K30, K31],
];
