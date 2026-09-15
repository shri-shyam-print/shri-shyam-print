const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
require("dotenv").config();

let Razorpay;
try {
  Razorpay = require("razorpay");
} catch (e) {
  console.error("Razorpay package missing. Run: npm install razorpay");
}

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

const ROOT = process.env.PRINT_ROOT || process.cwd();
const UPLOADS = path.join(ROOT, "uploads");
const JOBS = path.join(ROOT, "jobs");
const QUEUE = path.join(ROOT, "print-queue");
const PUBLIC = path.join(__dirname, "public");

for (const dir of [UPLOADS, JOBS, QUEUE]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

if (fs.existsSync(PUBLIC)) app.use(express.static(PUBLIC));

const upload = multer({
  dest: UPLOADS,
  limits: { fileSize: 50 * 1024 * 1024 }
});

const razorpay =
  Razorpay && process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET
    ? new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET
      })
    : null;

function jobPath(id) {
  return path.join(JOBS, `${id}.json`);
}

function saveJob(job) {
  fs.writeFileSync(jobPath(job.id), JSON.stringify(job, null, 2));
}

function readJob(id) {
  const p = jobPath(id);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

app.get("/", (req, res) => {
  res.json({
    status: "online",
    message: "Shri Shyam Print API is running"
  });
});

app.get("/api/status", (req, res) => {
  res.json({
    online: true,
    razorpayConfigured: !!razorpay,
    printQueue: QUEUE
  });
});

// Create Razorpay order and store the uploaded file locally.
app.post("/api/create-order", upload.single("file"), async (req, res) => {
  try {
    if (!razorpay) {
      return res.status(500).json({
        success: false,
        error: "Razorpay is not configured. Check RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env"
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "Please upload a file"
      });
    }

    const amountRupees = Number(req.body.amount);
    const pages = Number(req.body.pages || 1);
    const copies = Number(req.body.copies || 1);
    const service = String(req.body.service || "Print");

    if (!Number.isFinite(amountRupees) || amountRupees <= 0) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({
        success: false,
        error: "Invalid amount"
      });
    }

    const amountPaise = Math.round(amountRupees * 100);
    const jobId = crypto.randomUUID();

    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency: "INR",
      receipt: `SSP-${jobId.slice(0, 8)}`,
      notes: {
        service,
        pages: String(pages),
        copies: String(copies)
      }
    });

    const storedFile = path.join(UPLOADS, `${jobId}_${path.basename(req.file.originalname)}`);
    fs.renameSync(req.file.path, storedFile);

    saveJob({
      id: jobId,
      orderId: order.id,
      originalName: req.file.originalname,
      storedFile,
      service,
      pages,
      copies,
      amount: amountRupees,
      status: "PAYMENT_PENDING",
      createdAt: new Date().toISOString()
    });

    console.log("PAYMENT ORDER CREATED:", order.id, "Amount:", amountRupees);

    res.json({
      success: true,
      jobId,
      orderId: order.id,
      amount: amountPaise,
      currency: "INR",
      keyId: process.env.RAZORPAY_KEY_ID
    });
  } catch (error) {
    console.error("CREATE ORDER ERROR:", error);
    if (req.file?.path && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Verify Razorpay payment on the server. Only after verification is the file
// moved into print-queue, where the already-working index.js agent prints it.
app.post("/api/verify-payment", async (req, res) => {
  try {
    if (!razorpay) {
      return res.status(500).json({
        success: false,
        error: "Razorpay is not configured"
      });
    }

    const {
      jobId,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    } = req.body;

    if (!jobId || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        error: "Missing payment verification data"
      });
    }

    const job = readJob(jobId);
    if (!job) {
      return res.status(404).json({
        success: false,
        error: "Job not found"
      });
    }

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${job.orderId}|${razorpay_payment_id}`)
      .digest("hex");

    if (
      expectedSignature.length !== razorpay_signature.length ||
      !crypto.timingSafeEqual(
        Buffer.from(expectedSignature),
        Buffer.from(razorpay_signature)
      )
    ) {
      return res.status(400).json({
        success: false,
        error: "Payment signature verification failed"
      });
    }

    const payment = await razorpay.payments.fetch(razorpay_payment_id);

    if (payment.order_id !== job.orderId || payment.order_id !== razorpay_order_id) {
      return res.status(400).json({
        success: false,
        error: "Payment order mismatch"
      });
    }

    if (payment.status !== "captured") {
      return res.status(400).json({
        success: false,
        error: `Payment status is ${payment.status}, not captured`
      });
    }

    if (!fs.existsSync(job.storedFile)) {
      return res.status(500).json({
        success: false,
        error: "Uploaded file is missing"
      });
    }

    const safeName = path.basename(job.originalName).replace(/[^a-zA-Z0-9._-]/g, "_");
    const queueName = `${job.id}_${safeName}`;
    const queuePath = path.join(QUEUE, queueName);

    fs.copyFileSync(job.storedFile, queuePath);

    job.status = "PAID";
    job.paymentId = razorpay_payment_id;
    job.verifiedAt = new Date().toISOString();
    job.queueFile = queuePath;
    saveJob(job);

    console.log("PAYMENT VERIFIED - SENT TO PRINT QUEUE:", queueName);

    res.json({
      success: true,
      message: "Payment verified. Print job sent to Canon queue.",
      jobId: job.id,
      status: job.status
    });
  } catch (error) {
    console.error("VERIFY PAYMENT ERROR:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Keep the old local API working too.
app.post("/print", (req, res) => {
  try {
    const { filename, data } = req.body;

    if (!filename || !data) {
      return res.status(400).json({
        success: false,
        error: "filename and data are required"
      });
    }

    const safeName = path.basename(filename);
    const filePath = path.join(QUEUE, safeName);
    const pdfData = Buffer.from(data, "base64");

    fs.writeFileSync(filePath, pdfData);

    console.log("PDF received:", safeName);

    res.json({
      success: true,
      message: "PDF added to print queue",
      filename: safeName
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
// ================= BRIDGE API =================

function bridgeAuth(req, res, next) {
  const expected = process.env.PRINT_BRIDGE_TOKEN;

  if (!expected) {
    return res.status(503).json({
      success: false,
      error: "PRINT_BRIDGE_TOKEN is not configured"
    });
  }

  const got = String(req.get("authorization") || "")
    .replace(/^Bearer\s+/i, "");

  if (!got || got !== expected) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized"
    });
  }

  next();
}

app.get("/api/bridge/jobs", bridgeAuth, (req, res) => {
  try {
    const files = fs.readdirSync(JOBS).filter(name => name.endsWith(".json"));
    const jobs = [];

    for (const name of files) {
      try {
        const job = JSON.parse(
          fs.readFileSync(path.join(JOBS, name), "utf8")
        );

        if (job.status === "PAID" && !job.bridgeAckAt) {
          jobs.push({
            id: job.id,
            originalName: job.originalName,
            service: job.service || "Print",
            pages: job.pages || 1,
            copies: job.copies || 1,
            amount: job.amount || 0
          });
        }
      } catch {}
    }

    res.json({ success: true, jobs });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get("/api/bridge/jobs/:id/file", bridgeAuth, (req, res) => {
  try {
    const job = readJob(req.params.id);

    if (!job) {
      return res.status(404).json({
        success: false,
        error: "Job not found"
      });
    }

    if (job.status !== "PAID") {
      return res.status(409).json({
        success: false,
        error: `Job status is ${job.status}`
      });
    }

    if (!job.storedFile || !fs.existsSync(job.storedFile)) {
      return res.status(404).json({
        success: false,
        error: "Stored file not found"
      });
    }

    res.download(
      job.storedFile,
      path.basename(job.originalName || `${job.id}.pdf`)
    );
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post("/api/bridge/jobs/:id/ack", bridgeAuth, (req, res) => {
  try {
    const job = readJob(req.params.id);

    if (!job) {
      return res.status(404).json({
        success: false,
        error: "Job not found"
      });
    }

    job.bridgeAckAt = new Date().toISOString();
    job.bridgeLocalQueueName =
      String(req.body?.localQueueName || "");
    job.status = "PRINT_QUEUED";

    saveJob(job);

    res.json({
      success: true,
      jobId: job.id,
      status: job.status
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
app.listen(process.env.PORT || 3000, "0.0.0.0", () => {
  console.log("==============================");
  console.log("Shri Shyam Print API Started!");
  console.log("API: http://localhost:3000");
  console.log("Razorpay:", razorpay ? "CONFIGURED" : "NOT CONFIGURED");
  console.log("==============================");
});

