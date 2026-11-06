
const express = require('express')
const { MongoClient, ObjectId } = require('mongodb')
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
 // POST NEW ORDER
 // ======================================

app.post('/orders', async (req, res) => {
  try {
    // Retrieve the customer's checkout information
    const { name, phone, lessonIDs } = req.body || {}

    // Validate the customer's name
    const validName =
      typeof name === 'string' &&
      /^[A-Za-z]+(?: [A-Za-z]+)*$/.test(name.trim())

    // Validate the customer's phone number
    const validPhone =
      typeof phone === 'string' &&
      /^[0-9]+$/.test(phone.trim())

    if (!validName || !validPhone) {
      return res.status(400).json({
        error: 'Invalid customer name or phone number'
      })
    }

    // Check that the order contains valid lesson IDs
    const validLessonIDs =
      Array.isArray(lessonIDs) &&
      lessonIDs.length > 0 &&
      lessonIDs.every(
        id => typeof id === 'string' &&
          /^[a-fA-F0-9]{24}$/.test(id)
      )

    if (!validLessonIDs) {
      return res.status(400).json({
        error: 'Invalid or missing lesson IDs'
      })
    }

    // Convert lesson ID strings to MongoDB ObjectIds
    const objectIDs = lessonIDs.map(
      id => new ObjectId(id)
    )

    // Check that every selected lesson exists
    const uniqueIDs = [
      ...new Set(lessonIDs)
    ].map(id => new ObjectId(id))

    const existingLessons = await db
      .collection('lesson')
      .countDocuments({
        _id: { $in: uniqueIDs }
      })

    if (existingLessons !== uniqueIDs.length) {
      return res.status(400).json({
        error: 'One or more lessons do not exist'
      })
    }

    // Prepare the order document
    const newOrder = {
      name: name.trim(),
      phone: phone.trim(),
      lessonIDs: objectIDs,
      numberOfSpaces: objectIDs.length,
      orderDate: new Date()
    }

    // Save the order to MongoDB
    const result = await db
      .collection('order')
      .insertOne(newOrder)

    console.log(
      'Order saved successfully:',
      result.insertedId
    )

    res.status(201).json({
      message: 'Order saved successfully',
      orderId: result.insertedId,
      numberOfSpaces: newOrder.numberOfSpaces
    })

  } catch (error) {
    console.error('Error saving order:', error)

    res.status(500).json({
      error: 'Failed to save order'
    })
  }
})

// ======================================
// UPDATE LESSON BY ID
// ======================================

app.put('/lessons/:id', async (req, res) => {
  try {
    const { id } = req.params

    // Validate the provided ID is a valid MongoDB ObjectId
    if (!/^[a-fA-F0-9]{24}$/.test(id)) {
      return res.status(400).json({
        error: 'Invalid lesson ID format'
      })
    }

    const updates = req.body || {}

    // Only allow updating safe fields
    const allowedFields = ['price', 'space', 'subject', 'location', 'description', 'image']
    const filteredUpdates = {}

    for (const key of allowedFields) {
      if (key in updates) {
        filteredUpdates[key] = updates[key]
      }
    }

    if (Object.keys(filteredUpdates).length === 0) {
      return res.status(400).json({
        error: 'No valid fields provided to update'
      })
    }

    const result = await db
      .collection('lesson')
      .updateOne(
        { _id: new ObjectId(id) },
        { $set: filteredUpdates }
      )

    if (result.matchedCount === 0) {
      return res.status(404).json({
        error: 'Lesson not found'
      })
    }

    res.json({
      message: 'Lesson updated successfully',
      modifiedCount: result.modifiedCount
    })

  } catch (error) {
    console.error('Error updating lesson:', error)

    res.status(500).json({
      error: 'Failed to update lesson'
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
