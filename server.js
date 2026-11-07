
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

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`)
  next()
})

// ======================================
// CORS MIDDLEWARE
// ======================================

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', 'http://localhost:5173')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204)
  }

  next()
})

app.use(express.json())

// ======================================
// STATIC LESSON IMAGES
// ======================================

app.use('/images', express.static(path.join(__dirname, 'staticFiles')))

app.use('/images', (req, res) => {
  res.status(404).json({ error: 'Image not found' })
})

// ======================================
// HOME ROUTE
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
// POST AN ORDER WITH SPACE RESERVATION
// ======================================

app.post('/orders', async (req, res) => {
  const { name, phone, lessonIDs } = req.body || {}

  // Validate customer details
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

  // Repeated lesson IDs mean multiple spaces in one lesson
  const quantities = new Map()

  for (const id of lessonIDs) {
    const key = id.toLowerCase()
    quantities.set(key, (quantities.get(key) || 0) + 1)
  }

  const session = client.startSession()

  try {
    // Reserve spaces and save the order in one transaction
    const booking = await session.withTransaction(async () => {
      const updatedLessons = []
      const lessonCollection = db.collection('lesson')

      for (const [id, quantity] of quantities) {
        const objectId = new ObjectId(id)

        // Only update when enough spaces are available
        const result = await lessonCollection.updateOne(
          {
            _id: objectId,
            space: { $gte: quantity }
          },
          {
            $inc: { space: -quantity }
          },
          { session }
        )

        if (result.matchedCount !== 1) {
          const error = new Error(
            'A selected lesson does not exist or has insufficient spaces'
          )

          error.statusCode = 409
          throw error
        }

        // Retrieve updated spaces inside the transaction
        const updatedLesson = await lessonCollection.findOne(
          { _id: objectId },
          {
            projection: { space: 1 },
            session
          }
        )

        updatedLessons.push({
          id,
          space: updatedLesson.space
        })
      }

      // Prepare the MongoDB order
      const order = {
        name: name.trim(),
        phone: phone.trim(),
        lessonIDs: lessonIDs.map(id => new ObjectId(id)),
        numberOfSpaces: lessonIDs.length,
        orderDate: new Date()
      }

      // Insert the order inside the same transaction
      const result = await db
        .collection('order')
        .insertOne(order, { session })

      return {
        orderId: result.insertedId,
        numberOfSpaces: order.numberOfSpaces,
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
// PUT UPDATE LESSON
// ======================================

// Supports normal lesson updates and conditional
// availability confirmation after checkout.

app.put('/lessons/:id', async (req, res) => {
  try {
    const lessonID = req.params.id
    const updates = req.body

    // Validate MongoDB lesson ID
    if (!/^[a-fA-F0-9]{24}$/.test(lessonID)) {
      return res.status(400).json({
        error: 'Invalid lesson ID'
      })
    }

    // Validate request body
    if (
      !updates ||
      typeof updates !== 'object' ||
      Array.isArray(updates)
    ) {
      return res.status(400).json({
        error: 'Invalid update data'
      })
    }

    // Fields that can be updated
    const allowedFields = [
      'topic',
      'location',
      'price',
      'space',
      'image'
    ]

    const fields = Object.keys(updates)

    if (
      fields.length === 0 ||
      fields.some(field => !allowedFields.includes(field))
    ) {
      return res.status(400).json({
        error: 'No valid lesson attributes provided'
      })
    }

    // Validate text attributes
    for (const field of ['topic', 'location', 'image']) {
      if (
        field in updates &&
        (
          typeof updates[field] !== 'string' ||
          updates[field].trim() === ''
        )
      ) {
        return res.status(400).json({
          error: `Invalid ${field} value`
        })
      }
    }

    // Validate price
    if (
      'price' in updates &&
      (
        typeof updates.price !== 'number' ||
        !Number.isFinite(updates.price) ||
        updates.price < 0
      )
    ) {
      return res.status(400).json({
        error: 'Price must be a non-negative number'
      })
    }

    // Validate available spaces
    if (
      'space' in updates &&
      (
        !Number.isInteger(updates.space) ||
        updates.space < 0
      )
    ) {
      return res.status(400).json({
        error: 'Spaces must be a non-negative integer'
      })
    }

    const objectId = new ObjectId(lessonID)

    const filter = {
      _id: objectId
    }

    // ======================================
    // CONDITIONAL AVAILABILITY UPDATE
    // ======================================

    // Vue sends expectedSpace after POST /orders.
    // POST has already deducted the booked spaces.
    // PUT must not deduct them a second time.

    if (req.query.expectedSpace !== undefined) {
      const rawExpected = req.query.expectedSpace
      const expectedSpace = Number(rawExpected)

      // Validate the expected availability
      if (
        typeof rawExpected !== 'string' ||
        !/^\d+$/.test(rawExpected) ||
        !Number.isSafeInteger(expectedSpace) ||
        fields.length !== 1 ||
        fields[0] !== 'space' ||
        updates.space !== expectedSpace
      ) {
        return res.status(400).json({
          error: 'Invalid expectedSpace value'
        })
      }

      // Only proceed if the database still has
      // the same availability returned by POST.
      filter.space = expectedSpace
    }

    // ======================================
    // UPDATE MONGODB
    // ======================================

    const result = await db
      .collection('lesson')
      .updateOne(
        filter,
        { $set: updates }
      )

    // Handle missing lessons or changed availability
    if (result.matchedCount === 0) {
      const existingLesson = await db
        .collection('lesson')
        .findOne(
          { _id: objectId },
          { projection: { _id: 1 } }
        )

      if (!existingLesson) {
        return res.status(404).json({
          error: 'Lesson not found'
        })
      }

      return res.status(409).json({
        error: 'Lesson availability has changed; refresh your lessons'
      })
    }

    // Retrieve updated lesson information
    const updatedLesson = await db
      .collection('lesson')
      .findOne({ _id: objectId })

    return res.json({
      message: 'Lesson updated successfully',
      modifiedCount: result.modifiedCount,
      lesson: updatedLesson
    })

  } catch (error) {
    console.error('Error updating lesson:', error)

    return res.status(500).json({
      error: 'Failed to update lesson'
    })
  }
})

// ======================================
// UNKNOWN ROUTES
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
