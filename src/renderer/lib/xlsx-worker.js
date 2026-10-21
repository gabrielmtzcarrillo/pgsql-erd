// Reads a workbook off the page's thread: receives { name, bytes }, answers
// { sheets } or { error }.
import { readSpreadsheet } from './spreadsheet.js';

self.onmessage = async (e) => {
  try {
    self.postMessage({ sheets: await readSpreadsheet(e.data.name, e.data.bytes) });
  } catch (err) {
    self.postMessage({ error: err.message });
  }
};
