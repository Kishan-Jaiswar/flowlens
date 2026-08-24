const express = require('express');
const mongoose = require('mongoose');

const Note = mongoose.model('Note', new mongoose.Schema({ name: String }));
const app = express();

app.post('/api/notes', async (req, res) => {
  const note = await Note.create({ name: req.body.name });
  res.json(note);
});

module.exports = app;
