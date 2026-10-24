// Python 3's standard-library CSV reader independently verifies exported field boundaries.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { harness } = require("./report-state.test.cjs");

const cases = [
  ["Ordinary text", "Market Street", "00123"],
  ["Unicode", "Café, São Paulo, Chattanooga 😀", "00004"],
  ["Quotes and commas", 'He said "CARTA", then left', "1E10"],
  ["Carriage return", "North\rSouth", "00007"],
  ["Line feed", "North\nSouth", "00008"],
  ["CRLF", "North\r\nSouth", "00009"],
  ["Equals", "=1+2", "00010", true],
  ["Plus", "+SUM(1,2)", "00011", true],
  ["Minus expression", "-1+2", "00012", true],
  ["At sign", "@SUM(A1:A2)", "00013", true],
  ["Leading spaces", "  =1+2", "00014", true],
  ["Leading tab", "\t=1+2", "00015", true],
  ["Full-width equals", "＝1+2", "00016", true],
  ["Long ID", "Keep this ID as Text", "12345678901234567890"],
  ["Separator text", 'Market",=1+2; next stop', "00018"]
];
const fixtureRows = cases.map(([label, text, id]) => ({
  Case: label, Text: text, Identifier: id, Longitude: -85.3097, Total: 1282571, "=1+2": "Protected header"
}));

function readCsv(input) {
  const result = spawnSync("python", ["-c", "import csv,io,json,sys; data=sys.stdin.buffer.read().decode('utf-8-sig'); print(json.dumps(list(csv.reader(io.StringIO(data,newline=''),strict=True))))"], {
    input, encoding: "utf8", timeout: 10000, maxBuffer: 4 * 1024 * 1024
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  return JSON.parse(result.stdout);
}

async function report(rows) {
  const h = harness();
  const link = { click() {} };
  h.ui.document.createElement = () => link;
  const pending = h.run("CSV verification report");
  await new Promise(setImmediate);
  h.queries[0].resolve({
    schema: { fields: Object.keys(rows[0]).map(name => ({ name })) },
    numRows: rows.length, get: index => rows[index]
  });
  await pending;
  return { h, link };
}

async function writeExcelFixture(outputPath) {
  const { h } = await report(fixtureRows);
  await download(h, fixtureRows);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, Buffer.from(await h.downloads[0].arrayBuffer()));
}

async function download(h, rows) {
  const pending = h.export();
  await new Promise(setImmediate);
  h.queries.at(-1).resolve({
    schema: { fields: Object.keys(rows[0]).map(name => ({ name })) },
    numRows: rows.length, get: index => rows[index]
  });
  await pending;
}

module.exports = { writeExcelFixture, readCsv };

if (require.main === module) {
test("formula-like text and headers get a quoted protective tab, including whitespace and full-width prefixes", () => {
  const h = harness();
  const values = ["=1+2", "+SUM(1,2)", "-1+2", "@SUM(A1:A2)", "  =1+2", "\t=1+2", "\r=1+2", "\n=1+2", "\u0000=1+2", "\u200B=1+2", "\uFEFF=1+2", "＝1+2", "＋SUM(1,2)", "－1+2", "＠SUM(A1:A2)", "-12\n"];
  const csv = values.map((value, index) => `${index},${h.ui.csvEscape(value)}`).join("\r\n");
  assert.deepEqual(readCsv(csv), values.map((value, index) => [String(index), `\t${value}`]));
  for (const header of [...values, "-123", "+123"]) {
    assert(h.ui.csvEscape(header, true).startsWith('"\t'), JSON.stringify(header));
  }
});

test("complete signed decimal/scientific numbers remain unchanged while expressions are protected", () => {
  const h = harness();
  for (const value of [-85.3097, -1234.5, 0, 1282571, "-0", "+12", "-.5", "+.25", "-1e-12", "1.25E+6", "-12.", "00123", "12345678901234567890"]) {
    assert.equal(h.ui.csvEscape(value), String(value));
  }
  for (const value of ["-1+2", "+1*2", "-1e2+3", "-2^3", "+cmd", "-Infinity", " -12", "-12\n"]) {
    assert(h.ui.csvEscape(value).startsWith('"\t'), JSON.stringify(value));
  }
});

test("commas, quotes, CR, LF, CRLF, Unicode, blanks and identifiers survive an independent CSV reader", () => {
  const h = harness();
  const values = ["Market, Main", 'He said "CARTA"', "North\rSouth", "North\nSouth", "North\r\nSouth", "Café 😀", "00123", "12345678901234567890", 'Market",=1+2; next', "semi;colon", "", null, undefined];
  const csv = values.map((value, index) => `${index},${h.ui.csvEscape(value)}`).join("\r\n");
  assert.deepEqual(readCsv(csv), values.map((value, index) => [String(index), String(value ?? "")]));
});

test("the report download has UTF-8 identification, safe headers, unchanged numbers and ignores page search", async () => {
  const { h, link } = await report(fixtureRows);
  h.filter("Ordinary text");
  assert.match(h.ui.resultsMeta.textContent, /1 displayed \/ 15 loaded/);
  await download(h, fixtureRows);
  const bytes = Buffer.from(await h.downloads[0].arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const expected = [
    ["Case", "Text", "Identifier", "Longitude", "Total", "\t=1+2"],
    ...cases.map(([label, text, id, protect]) => [label, protect ? `\t${text}` : text, id, "-85.3097", "1282571", "Protected header"])
  ];
  assert.deepEqual(readCsv(bytes), expected);
  assert.equal(h.ui.exportCsvBtn.textContent, "Download report (CSV)");
  assert.match(link.download, /^carta_report_\d{4}-\d{2}-\d{2}_full\.csv$/);
  assert.equal(h.state().rows[6].Text, "=1+2", "CSV protection must not mutate displayed source data");
});

test("a capped display still downloads the full report without a partial filename", async () => {
  const rows = Array.from({ length: 5001 }, (_, index) => ({ row: index }));
  const { h, link } = await report(rows);
  assert.equal(h.state().rows.length, 5000);
  await download(h, rows);
  assert.match(link.download, /^carta_report_\d{4}-\d{2}-\d{2}_full\.csv$/);
  assert.equal(readCsv(Buffer.from(await h.downloads[0].arrayBuffer())).length, 5002);
});
}
