const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { Pool } = require('pg');
const { Parser } = require('json2csv');

const app = express();

// Enhanced CORS configuration
const allowedOrigins = [
  'https://blauerton.github.io', // Your GitHub Pages
  'http://localhost:3000'       // Local development
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: true
}));

app.use(express.json());

// PostgreSQL connection with enhanced error handling
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
    sslmode: 'require'
  }
});

// Environment variables validation
const CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET;
const SHORTCODE = process.env.MPESA_SHORTCODE;
const PASSKEY = process.env.MPESA_PASSKEY;
const ENVIRONMENT = process.env.MPESA_ENVIRONMENT || 'sandbox';
const BASE_URL = ENVIRONMENT === 'sandbox'
  ? 'https://sandbox.safaricom.co.ke'
  : 'https://api.safaricom.co.ke';

// Health check endpoint for Render monitoring
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT NOW()');
    res.status(200).json({
      status: 'OK',
      database: 'connected',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      status: 'ERROR',
      database: 'disconnected',
      error: error.message
    });
  }
});

// Database connection test endpoint
app.get('/dbcheck', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW() as time, VERSION() as version');
    res.json({
      database: 'Connected',
      time: result.rows[0].time,
      version: result.rows[0].version
    });
  } catch (error) {
    res.status(500).json({
      database: 'Connection failed',
      error: error.message
    });
  }
});

// Generate Access Token with better error handling
const getAccessToken = async () => {
  try {
    const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');
    const response = await axios.get(
      `${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
      {
        headers: {
          Authorization: `Basic ${auth}`
        },
        timeout: 5000 // 5-second timeout
      }
    );
    return response.data.access_token;
  } catch (error) {
    console.error('M-Pesa Auth Error:', error.response?.data || error.message);
    throw new Error('Failed to get access token');
  }
};

// Enhanced registration endpoint
app.post('/saveRegistration', async (req, res) => {
  try {
    console.log('Incoming registration data:', req.body);

    // Input validation
    const { fullName, phone, gender, categories } = req.body;
    if (!fullName || !phone || !gender || !categories?.length) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['fullName', 'phone', 'gender', 'categories'],
        received: req.body
      });
    }

    // Prepare data for insertion
    const timestamp = new Date();
    const query = `
      INSERT INTO registrations (
        full_name, phone, gender, categories,
        mixed_team_name, mixed_team_members,
        family_team_name, timestamp
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id;
    `;

    const values = [
      fullName,
      phone,
      gender,
      JSON.stringify(categories),
      req.body.mixedTeamName || null,
      req.body.mixedTeamMembers ? JSON.stringify(req.body.mixedTeamMembers) : null,
      req.body.familyTeamName || null,
      timestamp
    ];

    // Execute query
    const result = await pool.query(query, values);
    console.log('Registration saved with ID:', result.rows[0].id);

    res.status(201).json({
      success: true,
      registrationId: result.rows[0].id,
      timestamp
    });

  } catch (error) {
    console.error('Registration Error:', {
      error: error.message,
      query: error.query,
      stack: error.stack
    });

    res.status(500).json({
      error: 'Database operation failed',
      details: error.message,
      receivedData: req.body
    });
  }
});

// Enhanced STK Push initiation
app.post('/initiateStkPush', async (req, res) => {
  try {
    const { phoneNumber, amount } = req.body;

    // Validate input
    if (!phoneNumber || !amount) {
      return res.status(400).json({
        error: 'Missing phoneNumber or amount'
      });
    }

    const formattedPhone = phoneNumber.startsWith('0')
      ? `254${phoneNumber.slice(1)}`
      : phoneNumber;

    if (!formattedPhone.match(/^2547\d{8}$/)) {
      return res.status(400).json({
        error: 'Invalid phone number format. Use 07XXXXXXXX.'
      });
    }

    // Generate payment details
    const accessToken = await getAccessToken();
    const timestamp = new Date()
      .toISOString()
      .replace(/[^0-9]/g, '')
      .slice(0, 14);
    const password = Buffer.from(`${SHORTCODE}${PASSKEY}${timestamp}`).toString('base64');

    const stkPushPayload = {
      BusinessShortCode: SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: amount,
      PartyA: formattedPhone,
      PartyB: SHORTCODE,
      PhoneNumber: formattedPhone,
      CallBackURL: `${process.env.RENDER_EXTERNAL_URL}/callback`,
      AccountReference: 'SUTTC2025',
      TransactionDesc: 'Payment for SUTTC 2025 Tournament Registration'
    };

    console.log('Initiating STK Push with:', stkPushPayload);

    const response = await axios.post(
      `${BASE_URL}/mpesa/stkpush/v1/processrequest`,
      stkPushPayload,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );

    console.log('STK Push Response:', response.data);
    res.json(response.data);

  } catch (error) {
    console.error('STK Push Error:', {
      error: error.message,
      response: error.response?.data,
      stack: error.stack
    });

    res.status(500).json({
      error: 'Failed to initiate STK Push',
      details: error.response?.data || error.message
    });
  }
});

// Callback Endpoint with enhanced logging
app.post('/callback', (req, res) => {
  const callbackData = req.body;
  console.log('Payment Callback Received:', JSON.stringify(callbackData, null, 2));

  if (callbackData.Body?.stkCallback?.ResultCode === 0) {
    console.log('✅ Payment Successful:', {
      amount: callbackData.Body.stkCallback.CallbackMetadata?.Item.find(i => i.Name === 'Amount')?.Value,
      receipt: callbackData.Body.stkCallback.CallbackMetadata?.Item.find(i => i.Name === 'MpesaReceiptNumber')?.Value
    });
  } else {
    console.log('❌ Payment Failed:', callbackData.Body?.stkCallback?.ResultDesc);
  }

  res.status(200).json({ status: 'Callback processed' });
});

// Enhanced CSV download endpoint
app.get('/downloadRegistrations', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, full_name, phone, gender, categories,
             mixed_team_name, mixed_team_members,
             family_team_name, timestamp
      FROM registrations
      ORDER BY timestamp DESC
    `);

    const registrations = result.rows.map(row => ({
      ...row,
      categories: JSON.parse(row.categories),
      mixed_team_members: row.mixed_team_members ? JSON.parse(row.mixed_team_members) : null,
      timestamp: row.timestamp.toISOString()
    }));

    const fields = [
      { label: 'ID', value: 'id' },
      { label: 'Full Name', value: 'full_name' },
      { label: 'Phone', value: 'phone' },
      { label: 'Gender', value: 'gender' },
      { label: 'Categories', value: 'categories' },
      { label: 'Mixed Team', value: 'mixed_team_name' },
      { label: 'Team Members', value: 'mixed_team_members' },
      { label: 'Family Team', value: 'family_team_name' },
      { label: 'Registration Date', value: 'timestamp' }
    ];

    const json2csvParser = new Parser({ fields });
    const csv = json2csvParser.parse(registrations);

    res.header('Content-Type', 'text/csv');
    res.attachment(`registrations_${new Date().toISOString().slice(0,10)}.csv`);
    res.send(csv);

  } catch (error) {
    console.error('CSV Generation Error:', error);
    res.status(500).json({
      error: 'Failed to generate CSV',
      details: error.message
    });
  }
});

// Database initialization with retry logic
const initDb = async (attempt = 1) => {
  const maxAttempts = 3;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS registrations (
        id SERIAL PRIMARY KEY,
        full_name VARCHAR(255) NOT NULL,
        phone VARCHAR(20) NOT NULL,
        gender VARCHAR(10) NOT NULL,
        categories JSONB NOT NULL,
        mixed_team_name VARCHAR(255),
        mixed_team_members JSONB,
        family_team_name VARCHAR(255),
        timestamp TIMESTAMP NOT NULL
      );
    `);

    console.log('✅ Database table verified/created');
    const testCount = await pool.query('SELECT COUNT(*) FROM registrations');
    console.log(`📊 Table contains ${testCount.rows[0].count} records`);

  } catch (error) {
    console.error(`❌ Database initialization attempt ${attempt} failed:`, error.message);
    if (attempt < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
      return initDb(attempt + 1);
    }
    throw error;
  }
};

// Server startup with error handling
const PORT = process.env.PORT || 3000;
const startServer = async () => {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`🔗 Health check: http://localhost:${PORT}/health`);
      console.log(`🛠️  Environment: ${ENVIRONMENT}`);
    });
  } catch (error) {
    console.error('💥 Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
