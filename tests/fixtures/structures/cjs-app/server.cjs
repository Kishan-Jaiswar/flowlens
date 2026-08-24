const express = require('express');
const mongoose = require('mongoose');
const Item = mongoose.model('Item', new mongoose.Schema({ label: String }));
const router = express.Router();
router.get('/api/items', async (req, res) => res.json(await Item.find({})));
module.exports = router;
