import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const worker = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");

test("ABC calculates and saves only the user-selected period", () => {
  assert.match(source, /const selectedPeriod = ebayAbcPeriod/);
  assert.match(source, /periodResults\.set\(selectedPeriod, buildEbayAbcItems/);
  assert.doesNotMatch(source, /const periods = \[3, 6, 9, 12, 15, 18, 21, 24\]/);
  assert.match(source, /attachEbayAbcPeriodDetails/);
  assert.doesNotMatch(source, /\[\.\.\.periodResults\.entries\(\)\]\.flatMap\(\(\[period, periodItems\]\) => periodItems\.flatMap\(\(item\) => item\.details/);
});

test("ABC records its own crash-recovery task and yields before the selected-period calculation", () => {
  assert.match(source, /key: `abc-\$\{step\?\.key \|\| "analysis"\}`/);
  assert.match(source, /Calculating profitability · selected \$\{selectedPeriod\}-month period/);
  assert.match(source, /await new Promise\(\(resolve\) => window\.setTimeout\(resolve, 0\)\)/);
});

test("ABC paints results before sequential workbook construction", () => {
  assert.match(source, /results are ready · saving permanent files/);
  assert.match(source, /requestAnimationFrame\(\(\) => window\.requestAnimationFrame/);
  assert.match(source, /Preparing the multi-period ABC master workbook/);
  assert.match(source, /let analysis: XLSX\.WorkBook \| null/);
  assert.match(source, /analysis = null/);
  assert.doesNotMatch(source, /analysis: analysisWorkbook/);
  assert.doesNotMatch(source, /classes: ebayAbcClassMasterWorkbook/);
});

test("ABC releases raw source graphs and reports the last client stage", () => {
  assert.match(source, /profitData\.orders\.length = 0/);
  assert.match(source, /profitData\.financialsByOrder = \{\}/);
  assert.match(source, /cache\.rates\.clear\(\)/);
  assert.match(source, /\/api\/client-diagnostic/);
  assert.match(source, /unhandledrejection/);
  assert.match(worker, /STOCKLENS_CLIENT_STAGE/);
  assert.match(worker, /STOCKLENS_CLIENT_ERROR/);
});
