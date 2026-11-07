
const express = require('express')
const { MongoClient, ObjectId } = require('mongodb')
const path = require('path')

// ======================================
// SERVER CONFIGURATION
// ======================================

const app = express()
const PORT = process.env.PORT || 3000

const client = new MongoClient(process.env.MONGODB_URI)
const db = client.db(process.env.DB_NAME || 'afterSchoolLessons')

// ======================================
// LOGGER MIDDLEWARE
// ======================================

// Log requests, including those rejected for invalid JSON.
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`)
  next()
})

// ======================================
// CORS MIDDLEWARE
// ======================================

// Allow requests from the local Vue development server.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', 'http://localhost:5173')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204)
  }

  next()
})

// Parse incoming JSON after logging and CORS handling.
app.use(express.json())

// ======================================
// STATIC FILE MIDDLEWARE
// ======================================

app.use('/images', express.static(path.join(__dirname, 'staticFiles')))

app.use('/images', (req, res) => {
  res.status(404).json({ error: 'Image not found' })
})

// ======================================
// HOME API ROUTE
// ======================================

app.get('/', (req, res) => {
  res.json({ message: 'Huz Academy API is running' })
})

// ======================================
// GET ALL LESSONS
// ======================================

app.get('/lessons', async (req, res) => {
  try {
    const lessons = await db.collection('lesson').find({}).toArray()
    res.json(lessons)
  } catch (error) {
    console.error('Error retrieving lessons:', error)
    res.status(500).json({ error: 'Failed to retrieve lessons' })
  }
})

// ======================================
// POST NEW ORDER WITH SPACE RESERVATION
// ======================================

app.post('/orders', async (req, res) => {
  const { name, phone, lessonIDs } = req.body || {}

  // Validate the name, phone number and selected MongoDB IDs.
  const validName =
    typeof name === 'string' &&
    /^[A-Za-z]+(?: [A-Za-z]+)*$/.test(name.trim())

  const validPhone =
    typeof phone === 'string' &&
    /^[0-9]+$/.test(phone.trim())

  const validLessonIDs =
    Array.isArray(lessonIDs) &&
    lessonIDs.length > 0 &&
    lessonIDs.every(
      id => typeof id === 'string' && /^[a-fA-F0-9]{24}$/.test(id)
    )

  if (!validName || !validPhone || !validLessonIDs) {
    return res.status(400).json({
      error: 'Invalid checkout information'
    })
  }

  // A repeated lesson ID means the customer selected multiple spaces.
  const quantities = new Map()
  for (const id of lessonIDs) {
    const key = id.toLowerCase()
    quantities.set(key, (quantities.get(key) || 0) + 1)
  }

  const session = client.startSession()

  try {
    // MongoDB Atlas supports transactions on its replica sets.
    // Order creation and all space reductions either commit together or abort.
    const booking = await session.withTransaction(async () => {
      const updatedLessons = []
      const lessonCollection = db.collection('lesson')

      for (const [id, quantity] of quantities) {
        const objectId = new ObjectId(id)

        // This filter only matches if enough spaces remain.
        const result = await lessonCollection.updateOne(
          { _id: objectId, space: { $gte: quantity } },
          { $inc: { space: -quantity } },
          { session }
        )

        if (result.matchedCount !== 1) {
          const unavailable = new Error(
            'A selected lesson does not exist or has insufficient spaces'
          )
          unavailable.statusCode = 409
          throw unavailable
        }

        // Read the new availability inside this transaction.
        const updatedLesson = await lessonCollection.findOne(
          { _id: objectId },
          { projection: { space: 1 }, session }
        )

        updatedLessons.push({
          id,
          space: updatedLesson.space
        })
      }

      const newOrder = {
        name: name.trim(),
        phone: phone.trim(),
        lessonIDs: lessonIDs.map(id => new ObjectId(id)),
        numberOfSpaces: lessonIDs.length,
        orderDate: new Date()
      }

      const result = await db
        .collection('order')
        .insertOne(newOrder, { session })

      return {
        orderId: result.insertedId,
        numberOfSpaces: newOrder.numberOfSpaces,
        updatedLessons
      }
    })

    console.log('Booking completed:', booking.orderId)

    return res.status(201).json({
      message: 'Order submitted successfully',
      ...booking
    })
  } catch (error) {
    console.error('Error processing booking:', error)

    return res.status(error.statusCode === 409 ? 409 : 500).json({
      error: error.statusCode === 409
        ? error.message
        : 'Unable to complete booking'
    })
  } finally {
    await session.endSession()
  }
})

// ======================================
// UPDATE LESSON
// ======================================

// General-purpose PUT: allows setting the permitted lesson attributes.
app.put('/lessons/:id', async (req, res) => {
  try {
    const lessonID = req.params.id
    const updates = req.body

    if (!/^[a-fA-F0-9]{24}$/.test(lessonID)) {
      return res.status(400).json({ error: 'Invalid lesson ID' })
    }

    const allowedFields = ['topic', 'location', 'price', 'space', 'image']

    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      return res.status(400).json({ error: 'Invalid update data' })
    }

    const fields = Object.keys(updates)
    if (
      fields.length === 0 ||
      fields.some(field => !allowedFields.includes(field))
    ) {
      return res.status(400).json({
        error: 'No valid lesson attributes provided'
      })
    }

    for (const field of ['topic', 'location', 'image']) {
      if (
        field in updates &&
        (typeof updates[field] !== 'string' || updates[field].trim() === '')
      ) {
        return res.status(400).json({ error: `Invalid ${field} value` })
      }
    }

    if (
      'price' in updates &&
      (typeof updates.price !== 'number' ||
        !Number.isFinite(updates.price) ||
        updates.price < 0)
    ) {
      return res.status(400).json({
        error: 'Price must be a non-negative number'
      })
    }

    if (
      'space' in updates &&
      (!Number.isInteger(updates.space) || updates.space < 0)
    ) {
      return res.status(400).json({
        error: 'Spaces must be a non-negative integer'
      })
    }

    const objectId = new ObjectId(lessonID)
    const result = await db.collection('lesson').updateOne(
      { _id: objectId },
      { $set: updates }
    )

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Lesson not found' })
    }

    const updatedLesson = await db
      .collection('lesson')
      .findOne({ _id: objectId })

    res.json({
      message: 'Lesson updated successfully',
      lesson: updatedLesson
    })
  } catch (error) {
    console.error('Error updating lesson:', error)
    res.status(500).json({ error: 'Failed to update lesson' })
  }
})

// ======================================
// HANDLE UNKNOWN ROUTES
// ======================================

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' })
})

// ======================================
// START SERVER
// ======================================

app.listen(PORT, () => {
  console.log(`Huz Academy backend running on port ${PORT}`)
})
