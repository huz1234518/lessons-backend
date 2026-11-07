
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

app.use((req, res, next) => {
  console.log(
    `${new Date().toISOString()} - ${req.method} ${req.url}`
  )

  next()
})

// ======================================
// CORS MIDDLEWARE
// ======================================

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
// STATIC FILES
// ======================================

// Serve lesson images and teacher portraits.
app.use(
  '/images',
  express.static(
    path.join(__dirname, 'staticFiles')
  )
)

// Handle missing images.
app.use('/images', (req, res) => {
  res.status(404).json({
    error: 'Image not found'
  })
})

// ======================================
// HOME ROUTE
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

    return res.status(200).json(lessons)

  } catch (error) {
    console.error('Error retrieving lessons:', error)

    return res.status(500).json({
      error: 'Failed to retrieve lessons'
    })
  }
})

// ======================================
// POST ORDERS
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

  // Count how many spaces are being purchased
  // for each lesson.
  const quantities = new Map()

  for (const id of lessonIDs) {
    const key = id.toLowerCase()

    quantities.set(
      key,
      (quantities.get(key) || 0) + 1
    )
  }

  const session = client.startSession()

  try {
    // Reserve spaces and save the order
    // using a MongoDB transaction.
    const booking = await session.withTransaction(
      async () => {
        const updatedLessons = []

        const lessonCollection = db.collection('lesson')

        for (const [id, quantity] of quantities) {
          const objectId = new ObjectId(id)

          // Only reserve spaces if enough are available.
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
            const unavailable = new Error(
              'A selected lesson does not exist or has insufficient spaces'
            )

            unavailable.statusCode = 409

            throw unavailable
          }

          // Retrieve remaining availability.
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

        // Prepare the order document.
        const newOrder = {
          name: name.trim(),
          phone: phone.trim(),
          lessonIDs: lessonIDs.map(
            id => new ObjectId(id)
          ),
          numberOfSpaces: lessonIDs.length,
          orderDate: new Date()
        }

        // Insert order into MongoDB.
        const result = await db
          .collection('order')
          .insertOne(newOrder, { session })

        return {
          orderId: result.insertedId,
          numberOfSpaces: newOrder.numberOfSpaces,
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
    console.error('Error processing booking:', error)

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

app.put('/lessons/:id', async (req, res) => {
  try {
    const lessonID = req.params.id
    const updates = req.body

    // Validate MongoDB lesson ID.
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
    // CONDITIONAL AVAILABILITY CHECK
    // ======================================

    // POST already deducts purchased spaces.
    // This conditional PUT confirms availability
    // without deducting the spaces again.

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

      filter.space = expectedSpace
    }

    // Update the lesson.
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

    return res.status(200).json({
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
// GET LESSON ENROLMENT
// ======================================

app.get('/enrolment/:lessonid', async (req, res) => {
  try {
    const lessonID = req.params.lessonid

    // Validate ID.
    if (!/^[a-fA-F0-9]{24}$/.test(lessonID)) {
      return res.status(400).json({
        error: 'Invalid lesson ID'
      })
    }

    const objectId = new ObjectId(lessonID)

    // Check lesson exists.
    const lesson = await db
      .collection('lesson')
      .findOne({ _id: objectId })

    if (!lesson) {
      return res.status(404).json({
        error: 'Lesson not found'
      })
    }

    // Count purchased spaces in the order collection.
    const counts = await db
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

    const enrolment =
      counts.length > 0 ? counts[0].total : 0

    console.log(
      `Enrolment for ${lesson.topic}: ${enrolment}`
    )

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

// ======================================
// GET ALL TEACHERS — NEW FEATURE
// ======================================

// Return the three teachers stored in MongoDB.
//
// Each teacher document contains:
// firstName, lastName, image,
// displayOrder and lessonIDs.
//
// GET /teachers

app.get('/teachers', async (req, res) => {
  try {
    // ======================================
    // RETRIEVE TEACHERS
    // ======================================

    const teachers = await db
      .collection('teacher')
      .find({})
      .sort({ displayOrder: 1 })
      .toArray()

    // ======================================
    // RETRIEVE LESSON TOPICS
    // ======================================

    const lessons = await db
      .collection('lesson')
      .find({})
      .project({ topic: 1 })
      .toArray()

    // Match each lesson ID to its lesson document.
    const lessonMap = new Map(
      lessons.map(lesson => [
        lesson._id.toString(),
        lesson
      ])
    )

    // ======================================
    // COMBINE TEACHERS WITH THEIR LESSONS
    // ======================================

    const results = teachers.map(teacher => {
      const lessonIDs = Array.isArray(teacher.lessonIDs)
        ? teacher.lessonIDs
        : []

      return {
        _id: teacher._id,

        firstName: teacher.firstName,

        lastName: teacher.lastName,

        image: teacher.image,

        lessonIDs: lessonIDs,

        lessons: lessonIDs
          .map(id => lessonMap.get(id.toString()))
          .filter(Boolean)
          .map(lesson => ({
            _id: lesson._id,
            topic: lesson.topic
          }))
      }
    })

    console.log(
      `Retrieved ${results.length} teachers`
    )

    return res.status(200).json(results)

  } catch (error) {
    console.error('Error retrieving teachers:', error)

    return res.status(500).json({
      error: 'Failed to retrieve teachers'
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
