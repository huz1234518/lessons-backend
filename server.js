
const express = require('express')
const { MongoClient } = require('mongodb')
const path = require('path')

// ======================================
// SERVER CONFIGURATION
// ======================================

const app = express()

const PORT = process.env.PORT || 3000

const client = new MongoClient(
  process.env.MONGODB_URI
)

const db = client.db(
  process.env.DB_NAME || 'afterSchoolLessons'
)

// Parse incoming JSON data
app.use(express.json())

// ======================================
// LOGGER MIDDLEWARE
// ======================================

// Log every request to the server
app.use((req, res, next) => {
  console.log(
    `${new Date().toISOString()} - ${req.method} ${req.url}`
  )

  next()
})

// ======================================
// CORS MIDDLEWARE
// ======================================

// Allow our Vue frontend to access the API
app.use((req, res, next) => {
  res.setHeader(
    'Access-Control-Allow-Origin',
    'http://localhost:5173'
  )

  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, OPTIONS'
  )

  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type'
  )

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204)
  }

  next()
})

// ======================================
// STATIC FILE MIDDLEWARE
// ======================================

// Serve images from the staticFiles folder
app.use(
  '/images',
  express.static(
    path.join(__dirname, 'staticFiles')
  )
)

// Handle images that do not exist
app.use('/images', (req, res) => {
  res.status(404).json({
    error: 'Image not found'
  })
})

// ======================================
// HOME API ROUTE
// ======================================

app.get('/', (req, res) => {
  res.json({
    message: 'Huz Academy API is running'
  })
})

// ======================================
// GET ALL LESSONS
// ======================================

app.get('/lessons', async (req, res) => {
  try {
    const lessons = await db
      .collection('lesson')
      .find({})
      .toArray()

    res.json(lessons)
  } catch (error) {
    console.error(
      'Error retrieving lessons:',
      error
    )

    res.status(500).json({
      error: 'Failed to retrieve lessons'
    })
  }
})

// ======================================
// HANDLE UNKNOWN ROUTES
// ======================================

app.use((req, res) => {
  res.status(404).json({
    error: 'Route not found'
  })
})

// ======================================
// START SERVER
// ======================================

app.listen(PORT, () => {
  console.log(
    `Huz Academy backend running on port ${PORT}`
  )
})
