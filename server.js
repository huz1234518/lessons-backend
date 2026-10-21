
const express = require('express');

const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;

const client = new MongoClient(process.env.MONGODB_URI);
const db = client.db(process.env.DB_NAME);

// Allow the server to read JSON requests
app.use(express.json());


 // Allow requests from our Vue.js frontend
app.use((req, res, next) => {
  res.setHeader(
    'Access-Control-Allow-Origin',
    'http://localhost:5173'
  );

  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, OPTIONS'
  );

  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type'
  );

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});


// Our first GET route
app.get('/', (req, res) => {
  res.json({ message: 'After-school lessons API is running' });
});


app.get('/lessons', async (req, res) => {
  try {
    const lessons = await db.collection('lesson').find({}).toArray();

    res.json(lessons);
  } catch (error) {
    console.error('Error fetching lessons:', error);
    res.status(500).json({ error: 'Failed to retrieve lessons' });
  }
});


// Start the server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
