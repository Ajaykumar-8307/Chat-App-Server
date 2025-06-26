import  express from 'express'
import { WebSocketServer } from 'ws'
import { createServer } from 'http'
import bcrypt from 'bcryptjs'
import User from './models/User.js'
import Group from './models/Group.js'
import cors from 'cors'
import jwt from 'jsonwebtoken'
import mongoose from 'mongoose'
import Message from './models/Message.js'

const app = express()
const server = createServer(app)
const wss = new WebSocketServer({ server })

const JWT_SECRET = 'your-secret-key'
const MONGODB_URI = 'mongodb+srv://kjajaykumar8307:FDOAW6lMs8tetP4A@jdoodleserver.sgscupf.mongodb.net/'

// Connect to MongoDB
mongoose.connect(MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err))

app.use(cors())
app.use(express.json())

const  connectedUsers = new Map()

const generateGroupCode = () => {
  return Math.random().toString(36).substring(2, 8).toUpperCase()
} 

// Auth middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization']
  const token = authHeader && authHeader.split(' ')[1]

  if (!token) return res.sendStatus(401)

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403)
    req.user = user
    next()
  })
} 

// Register
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' })
  }

  try {
    const existingUser = await User.findOne({ username })
    if (existingUser) {
      return res.status(400).json({ error: 'Username already exists' })
    }

    const hashedPassword = await bcrypt.hash(password, 10)
    const user = new User({ username, password: hashedPassword })
    await user.save()

    const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET)
    res.json({ user: { id: user._id, username: user.username }, token })
  } catch (error) {
    res.status(500).json({ error: 'Registration failed' })
  }
})

// Login
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body

  try {
    const user = await User.findOne({ username })
    
    if (!user || !await bcrypt.compare(password, user.password)) {
      return res.status(401).json({ error: 'Invalid credentials' })
    }

    const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET)
    res.json({ user: { id: user._id, username: user.username }, token })
  } catch (error) {
    res.status(500).json({ error: 'Login failed' })
  }
})

//  Verify token
app.get('/api/verify', authenticateToken, (req, res) => {
  res.json({ user: req.user })
})

// Get user groups
app.get('/api/groups', authenticateToken, async (req, res) => {
  try {
    const groups = await Group.find({ members: req.user.id })
      .populate('members', 'username')
      .sort({ created_at: -1 })
    res.json(groups)
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch groups' })
  }
})

// Create group
app.post('/api/groups', authenticateToken, async (req, res) => {
  const { name } = req.body

  if (!name) {
    return res.status(400).json({ error: 'Group name required' })
  }

  try {
    let code
    let codeExists = true
    while (codeExists) {
      code = generateGroupCode()
      const existing = await Group.findOne({ code })
      if (!existing) codeExists = false
    }

    const group = new Group({
      name,
      code,
      members: [req.user.id],
      created_by: req.user.id
    })

    await group.save()
    await group.populate('members', 'username')
    res.json(group)
  } catch (error) {
    res.status(500).json({ error: 'Failed to create group' })
  }
})

// Join group
app.post('/api/groups/join', authenticateToken, async (req, res) => {
  const { code } = req.body

  if (!code) {
    return res.status(400).json({ error: 'Group code required' })
  }

  try {
    const group = await Group.findOne({ code })
    if (!group) {
      return res.status(404).json({ error: 'Group not found' })
    }

    if (!group.members.includes(req.user.id)) {
      group.members.push(req.user.id)
      await group.save()
    }

    await group.populate('members', 'username')
    res.json(group)
  } catch (error) {
    res.status(500).json({ error: 'Failed to join group' })
  }
}) 

//  WebSocket connection
wss.on('connection', async (ws, request) => {
  const url = new URL(request.url, 'http://localhost:3001')
  const token = url.searchParams.get('token')
  const groupId = url.searchParams.get('groupId')

  if (!token || !groupId) {
    ws.close()
    return
  }

  try {
    const user = jwt.verify(token, JWT_SECRET)
    
    // Verify user is member of group
    const group = await Group.findById(groupId)
    if (!group || !group.members.includes(user.id)) {
      ws.close()
      return
    }

    connectedUsers.set(ws, { user, groupId })

    // Send chat history
    const messages = await Message.find({ group_id: groupId })
      .sort({ created_at: -1 })
      .limit(50)
    
    ws.send(JSON.stringify({
      type: 'history',
      messages: messages.reverse()
    }))

    ws.on('message', async (data) => {
      const messageData = JSON.parse(data.toString())

      if (messageData.type === 'message') {
        try {
          const message = new Message({
            user_id: user.id,
            username: user.username,
            content: messageData.content,
            group_id: groupId
          })
          await message.save()

          const messageResponse = {
            type: 'message',
            message: {
              _id: message._id,
              user_id: message.user_id,
              username: message.username,
              content: message.content,
              created_at: message.created_at
            }
          }

          // Broadcast to all users in the group
          wss.clients.forEach(client => {
            const clientData = connectedUsers.get(client)
            if (client.readyState === client.OPEN && 
                clientData && clientData.groupId === groupId) {
              client.send(JSON.stringify(messageResponse))
            }
          })
        } catch (error) {
          console.error('Error saving message:', error)
        }
      }
    })

    ws.on('close', () => {
      connectedUsers.delete(ws)
    })

  } catch (error) {
    ws.close()
  }
})  

server.listen(3001, () => {
  console.log('Server running on port 3001')
})
 