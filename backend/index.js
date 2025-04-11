const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { Pool } = require('pg');
const { Parser } = require('json2csv');

const app = express();
app.use(cors());
app.use(express.json());

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Environment variables
const CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET;
const SHORTCODE = process.env.MPESA_SHORTCODE;
const PASSKEY = process.env.MPESA_PASSKEY;
const ENVIRONMENT = process.env.MPESA_ENVIRONMENT || 'sandbox';
const BASE_URL = ENVIRONMENT === 'sandbox' ? 'https://sandbox.safaricom.co.ke' : 'https://api.safaricom.co.ke';

// Generate Access Token
const getAccessToken = async () => {
  const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');
  const response = await axios.get(
    `${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: {
        Authorization: `Basic ${auth}`
      }
    }
  );
  return response.data.access_token;
};

// Save Registration Data
app.post('/saveRegistration', async (req, res) => {
  try {
    const registrationData = req.body;
    const { fullName, phone, gender, categories, mixedTeamName, mixedTeamMembers, familyTeamName } = registrationData;
    const timestamp = new Date();

    const query = `
      INSERT INTO registrations (full_name, phone, gender, categories, mixed_team_name, mixed_team_members, family_team_name, timestamp)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *;
    `;
    const values = [
      fullName,
      phone,
      gender,
      JSON.stringify(categories),
      mixedTeamName,
      mixedTeamMembers ? JSON.stringify(mixedTeamMembers) : null,
      familyTeamName,
      timestamp
    ];

    await pool.query(query, values);
    res.status(200).json({ message: 'Registration data saved successfully' });
  } catch (error) {
    console.error('Error saving registration data:', error);
    res.status(500).json({ error: 'Failed to save registration data' });
  }
});

// Initiate STK Push
app.post('/initiateStkPush', async (req, res) => {
  try {
    const { phoneNumber, amount } = req.body;

    const formattedPhone = phoneNumber.startsWith('0')
      ? `254${phoneNumber.slice(1)}`
      : phoneNumber;

    if (!formattedPhone.match(/^2547\d{8}$/)) {
      return res.status(400).json({ error: 'Invalid phone number format. Use 07XXXXXXXX.' });
    }

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

    const response = await axios.post(
      `${BASE_URL}/mpesa/stkpush/v1/processrequest`,
      stkPushPayload,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error('Error initiating STK Push:', error.response ? error.response.data : error.message);
    res.status(500).json({
      error: 'Failed to initiate STK Push',
      details: error.response ? error.response.data : error.message
    });
  }
});

// Callback Endpoint for M-Pesa
app.post('/callback', (req, res) => {
  const callbackData = req.body;
  console.log('Callback received:', callbackData);

  if (callbackData.Body.stkCallback.ResultCode === 0) {
    console.log('Payment successful:', callbackData.Body.stkCallback);
  } else {
    console.log('Payment failed:', callbackData.Body.stkCallback.ResultDesc);
  }

  res.status(200).json({ status: 'Callback received' });
});

// Download Registration Data as CSV
app.get('/downloadRegistrations', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM registrations');
    const registrations = result.rows.map(row => ({
      ...row,
      categories: JSON.parse(row.categories),
      mixed_team_members: row.mixed_team_members ? JSON.parse(row.mixed_team_members) : null,
      timestamp: row.timestamp.toISOString()
    }));

    const fields = [
      'full_name',
      'phone',
      'gender',
      'categories',
      'mixed_team_name',
      'mixed_team_members',
      'family_team_name',
      'timestamp'
    ];
    const json2csvParser = new Parser({ fields });
    const csv = json2csvParser.parse(registrations);

    res.header('Content-Type', 'text/csv');
    res.attachment('registrations.csv');
    res.send(csv);
  } catch (error) {
    console.error('Error generating CSV:', error);
    res.status(500).json({ error: 'Failed to generate CSV' });
  }
});

// Initialize the database
const initDb = async () => {
  const createTableQuery = `
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
  `;
  await pool.query(createTableQuery);
  console.log('Database initialized');
};

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await initDb();
  console.log(`Server running on port ${PORT}`);
});
