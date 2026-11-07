
const { MongoClient } = require('mongodb')

const client = new MongoClient(process.env.MONGODB_URI)

const db = client.db(
  process.env.DB_NAME || 'afterSchoolLessons'
)

async function seedTeachers() {
  try {
    await client.connect()
    console.log('Connected to MongoDB Atlas')

    // Get the lessons already stored in MongoDB.
    const lessons = await db
      .collection('lesson')
      .find({})
      .toArray()

    // Match lesson topics to their MongoDB IDs.
    const lessonMap = new Map()

    for (const lesson of lessons) {
      lessonMap.set(
        lesson.topic.trim().toLowerCase(),
        lesson._id
      )
    }

    // Define the three teachers.
    const teachers = [
      {
        firstName: 'Huzaifa',
        lastName: 'A',
        image: 'Huzaifa.jpg',
        displayOrder: 1,
        subjects: [
          'Mathematics',
          'Art',
          'Religious Studies',
          'Music'
        ]
      },
      {
        firstName: 'Ubaida',
        lastName: 'B',
        image: 'Ubaida.jpg',
        displayOrder: 2,
        subjects: [
          'Swimming',
          'Science',
          'Programming'
        ]
      },
      {
        firstName: 'Amil',
        lastName: 'C',
        image: 'Amil.jpg',
        displayOrder: 3,
        subjects: [
          'English',
          'Robotics',
          'French'
        ]
      }
    ]

    // Check that every assigned subject exists.
    const missingSubjects = teachers
      .flatMap(teacher => teacher.subjects)
      .filter(subject =>
        !lessonMap.has(subject.toLowerCase())
      )

    if (missingSubjects.length > 0) {
      throw new Error(
        'Missing lessons in MongoDB: ' +
        [...new Set(missingSubjects)].join(', ')
      )
    }

    const teacherCollection = db.collection('teacher')

    // Insert or update each teacher.
    for (const teacher of teachers) {
      const lessonIDs = teacher.subjects.map(
        subject => lessonMap.get(subject.toLowerCase())
      )

      await teacherCollection.updateOne(
        {
          firstName: teacher.firstName,
          lastName: teacher.lastName
        },
        {
          $set: {
            firstName: teacher.firstName,
            lastName: teacher.lastName,
            image: teacher.image,
            displayOrder: teacher.displayOrder,
            lessonIDs: lessonIDs
          }
        },
        {
          upsert: true
        }
      )

      console.log(
        `Saved ${teacher.firstName} ${teacher.lastName}`
      )
    }

    console.log('All three teachers saved successfully!')

  } catch (error) {
    console.error('Error seeding teachers:', error)
    process.exitCode = 1

  } finally {
    await client.close()
  }
}

seedTeachers()
