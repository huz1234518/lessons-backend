
const express = require('express')
const { MongoClient, ObjectId } = require('mongodb')
const path = require('path')

// ======================================
// SERVER CONFIGURATION
// ======================================

const app = express()
const PORT = process.env.PORT || 3000

const client = new MongoClient(process.env.MONGODB_URI)

const db = client.db(
  process.env.DB_NAME || 'afterSchoolLessons'
)

// ======================================
// LOGGER MIDDLEWARE
// ======================================

// Log all incoming requests.
app.use((req, res, next) => {
  console.log(
    `${new Date().toISOString()} - ${req.method} ${req.url}`
  )

  next()
})

// ======================================
// CORS MIDDLEWARE
// ======================================

// Allow requests from the Vue frontend.
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

// Parse incoming JSON requests.
app.use(express.json())

// ======================================
// STATIC FILE MIDDLEWARE
// ======================================

// Serve lesson images from staticFiles.
app.use(
  '/images',
  express.static(
    path.join(__dirname, 'staticFiles')
  )
)

// Return 404 when an image does not exist.
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
// POST NEW ORDER WITH SPACE RESERVATION
// ======================================

app.post('/orders', async (req, res) => {
  const { name, phone, lessonIDs } = req.body || {}

  // Validate customer name.
  const validName =
    typeof name === 'string' &&
    /^[A-Za-z]+(?: [A-Za-z]+)*$/.test(name.trim())

  // Validate phone number.
  const validPhone =
    typeof phone === 'string' &&
    /^[0-9]+$/.test(phone.trim())

  // Validate lesson IDs.
  const validLessonIDs =
    Array.isArray(lessonIDs) &&
    lessonIDs.length > 0 &&
    lessonIDs.every(
      id =>
        typeof id === 'string' &&
        /^[a-fA-F0-9]{24}$/.test(id)
    )

  if (!validName || !validPhone || !validLessonIDs) {
    return res.status(400).json({
      error: 'Invalid checkout information'
    })
  }

  // Count spaces requested for each lesson.
  // Repeated IDs represent multiple spaces.
  const quantities = new Map()

  for (const id of lessonIDs) {
    const key = id.toLowerCase()

    quantities.set(
      key,
      (quantities.get(key) || 0) + 1
    )
  }

  // Start a MongoDB session.
  const session = client.startSession()

  try {
    // Perform booking operations in one transaction.
    const booking = await session.withTransaction(
      async () => {
        const updatedLessons = []

        const lessonCollection = db.collection('lesson')

        // Reserve available spaces.
        for (const [id, quantity] of quantities) {
          const objectId = new ObjectId(id)

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

          // Reject unavailable lessons.
          if (result.matchedCount !== 1) {
            const error = new Error(
              'A selected lesson does not exist or has insufficient spaces'
            )

            error.statusCode = 409

            throw error
          }

          // Get the remaining spaces.
          const updatedLesson =
            await lessonCollection.findOne(
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

        // Prepare the new order.
        const order = {
          name: name.trim(),
          phone: phone.trim(),
          lessonIDs: lessonIDs.map(
            id => new ObjectId(id)
          ),
          numberOfSpaces: lessonIDs.length,
          orderDate: new Date()
        }

        // Save the order in the same transaction.
        const result = await db
          .collection('order')
          .insertOne(order, { session })

        return {
          orderId: result.insertedId,
          numberOfSpaces: order.numberOfSpaces,
          updatedLessons
        }
      }
    )

    console.log(
      'Booking completed:',
      booking.orderId
    )

    return res.status(201).json({
      message: 'Order submitted successfully',
      ...booking
    })

  } catch (error) {
    console.error(
      'Error processing booking:',
      error
    )

    return res.status(
      error.statusCode === 409 ? 409 : 500
    ).json({
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

// Update permitted lesson attributes.
// Also supports conditional availability checks.

app.put('/lessons/:id', async (req, res) => {
  try {
    const lessonID = req.params.id
    const updates = req.body

    // Validate MongoDB ID.
    if (!/^[a-fA-F0-9]{24}$/.test(lessonID)) {
      return res.status(400).json({
        error: 'Invalid lesson ID'
      })
    }

    // Validate request body.
    if (
      !updates ||
      typeof updates !== 'object' ||
      Array.isArray(updates)
    ) {
      return res.status(400).json({
        error: 'Invalid update data'
      })
    }

    // Allowed lesson attributes.
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
      fields.some(
        field => !allowedFields.includes(field)
      )
    ) {
      return res.status(400).json({
        error: 'No valid lesson attributes provided'
      })
    }

    // Validate text attributes.
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

    // Validate price.
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

    // Validate spaces.
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

    // POST already deducts booked spaces.
    // PUT confirms the remaining availability
    // without deducting it twice.

    if (req.query.expectedSpace !== undefined) {
      const rawExpected = req.query.expectedSpace
      const expectedSpace = Number(rawExpected)

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

      // Only match if availability has not changed.
      filter.space = expectedSpace
    }

    // Update the MongoDB lesson document.
    const result = await db
      .collection('lesson')
      .updateOne(
        filter,
        { $set: updates }
      )

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

    const updatedLesson = await db
      .collection('lesson')
      .findOne({ _id: objectId })

    return res.json({
      message: 'Lesson updated successfully',
      modifiedCount: result.modifiedCount,
      lesson: updatedLesson
    })

  } catch (error) {
    console.error(
      'Error updating lesson:',
      error
    )

    return res.status(500).json({
      error: 'Failed to update lesson'
    })
  }
})

// ======================================
// GET LESSON ENROLMENT
// ======================================

// Returns the number of purchased spaces
// for a particular lesson.
//
// Example:
// GET /enrolment/LESSON_ID

app.get('/enrolment/:lessonid', async (req, res) => {
  try {
    const lessonID = req.params.lessonid

    // Validate lesson ID.
    if (!/^[a-fA-F0-9]{24}$/.test(lessonID)) {
      return res.status(400).json({
        error: 'Invalid lesson ID'
      })
    }

    const objectId = new ObjectId(lessonID)

    // Check that the lesson exists.
    const lesson = await db
      .collection('lesson')
      .findOne({ _id: objectId })

    if (!lesson) {
      return res.status(404).json({
        error: 'Lesson not found'
      })
    }

    // ======================================
    // CALCULATE ENROLMENT FROM ORDERS
    // ======================================

    // Each occurrence of a lesson ID represents
    // one purchased space.
    //
    // $unwind separates the IDs within orders.
    // $match selects purchases for this lesson.
    // $count counts all matching purchases.

    const result = await db
      .collection('order')
      .aggregate([
        {
          $unwind: '$lessonIDs'
        },
        {
          $match: {
            lessonIDs: objectId
          }
        },
        {
          $count: 'total'
        }
      ])
      .toArray()

    // If no orders exist, enrolment is zero.
    const enrolment =
      result.length > 0 ? result[0].total : 0

    console.log(
      `Enrolment for ${lesson.topic}: ${enrolment}`
    )

    return res.status(200).json({
      lessonID: lessonID,
      topic: lesson.topic,
      enrolment: enrolment
    })

  } catch (error) {
    console.error(
      'Error retrieving enrolment:',
      error
    )

    return res.status(500).json({
      error: 'Failed to retrieve enrolment'
    })
  }
})

// ======================================
// HANDLE UNKNOWN ROUTES
// ======================================

 // ======================================
 // GET LESSON ENROLMENT
 // ======================================

app.get('/enrolment/:lessonid', async (req, res) => {
  try {
    const lessonID = req.params.lessonid

    // Validate lesson ID
    if (!/^[a-fA-F0-9]{24}$/.test(lessonID)) {
      return res.status(400).json({
        error: 'Invalid lesson ID'
      })
    }

    const objectId = new ObjectId(lessonID)

    // Check whether the lesson exists
    const lesson = await db
      .collection('lesson')
      .findOne({ _id: objectId })

    if (!lesson) {
      return res.status(404).json({
        error: 'Lesson not found'
      })
    }

    // Count purchased spaces from order documents
    const result = await db
      .collection('order')
      .aggregate([
        { $unwind: '$lessonIDs' },
        { $match: { lessonIDs: objectId } },
        { $count: 'total' }
      ])
      .toArray()

    const enrolment = result.length > 0
      ? result[0].total
      : 0

    return res.status(200).json({
      lessonID,
      topic: lesson.topic,
      enrolment
    })

  } catch (error) {
    console.error('Error retrieving enrolment:', error)

    return res.status(500).json({
      error: 'Failed to retrieve enrolment'
    })
  }
})


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
