
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

// Allow the server to read JSON requests
app.use(express.json());

// Our first GET route
app.get('/', (req, res) => {
  res.json({ message: 'After-school lessons API is running' });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
