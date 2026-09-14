const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const BASE = "C:\\shrishyamprint";

const QUEUE = path.join(BASE, "print-queue");
const PRINTED = path.join(BASE, "printed");
const FAILED = path.join(BASE, "failed");

const PRINTER = "Canon G3010 series";

const SUMATRA_CANDIDATES = [
  path.join(process.env.LOCALAPPDATA || "", "SumatraPDF", "SumatraPDF.exe"),
  path.join(process.env.ProgramFiles || "", "SumatraPDF", "SumatraPDF.exe"),
  path.join(process.env["ProgramFiles(x86)"] || "", "SumatraPDF", "SumatraPDF.exe")
];

function findSumatra() {
  for (const file of SUMATRA_CANDIDATES) {
    if (fs.existsSync(file)) {
      return file;
    }
  }
  return null;
}

function ensureFolders() {
  [QUEUE, PRINTED, FAILED].forEach(folder => {
    if (!fs.existsSync(folder)) {
      fs.mkdirSync(folder, { recursive: true });
    }
  });
}

function printFile(filePath, fileName) {
  const sumatra = findSumatra();

  if (!sumatra) {
    console.log("ERROR: SumatraPDF.exe not found!");
    return;
  }

  console.log("Printing:", fileName);

  const child = spawn(
    sumatra,
    ["-print-to", PRINTER, filePath],
    {
      windowsHide: true
    }
  );

  child.on("error", (error) => {
    console.log("PRINT ERROR:", error.message);

    try {
      fs.renameSync(
        filePath,
        path.join(FAILED, fileName)
      );
    } catch {}
  });

  child.on("close", (code) => {
    if (code === 0) {
      console.log("PRINT SUCCESS:", fileName);

      try {
        fs.renameSync(
          filePath,
          path.join(PRINTED, fileName)
        );
      } catch (error) {
        console.log("Move error:", error.message);
      }
    } else {
      console.log("PRINT FAILED:", fileName, "Code:", code);

      try {
        fs.renameSync(
          filePath,
          path.join(FAILED, fileName)
        );
      } catch {}
    }
  });
}

const processing = new Set();

function checkQueue() {
  if (!fs.existsSync(QUEUE)) return;

  const files = fs.readdirSync(QUEUE);

  for (const fileName of files) {
    const filePath = path.join(QUEUE, fileName);

    if (processing.has(fileName)) continue;

    const ext = path.extname(fileName).toLowerCase();

    if (![".pdf", ".jpg", ".jpeg", ".png"].includes(ext)) {
      continue;
    }

    try {
      const stat = fs.statSync(filePath);

      if (!stat.isFile()) continue;

      processing.add(fileName);

      printFile(filePath, fileName);
    } catch (error) {
      console.log("Queue error:", error.message);
    }
  }
}

ensureFolders();

console.log("==============================");
console.log("Shri Shyam Print Agent Started!");
console.log("Printer:", PRINTER);
console.log("Watching:", QUEUE);
console.log("==============================");

checkQueue();

setInterval(checkQueue, 2000);