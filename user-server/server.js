/* Modified for IP Bot: publication preparation, configuration or security changes. See CHANGELOG.md. */
const express = require('express')
const cors = require('cors')
const sqlite3 = require('sqlite3').verbose()
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const path = require('path')

const { loadLocalConfig } = require('../scripts/local-config.cjs')
const sensitiveConfig = loadLocalConfig(path.join(__dirname, '..'))

const app = express()
const allowedOrigins = new Set(String(sensitiveConfig.CORS_ORIGINS || 'http://127.0.0.1:3344,http://localhost:3344').split(',').map(s => s.trim()))
app.use(cors({ origin: (origin, callback) => callback(null, !origin || origin === 'null' || origin === 'file://' || allowedOrigins.has(origin)) }))
app.use(express.json())

const JWT_SECRET = sensitiveConfig.JWT_SECRET
if (typeof JWT_SECRET !== 'string' || JWT_SECRET.length < 32) throw new Error('JWT_SECRET must have at least 32 characters. Run npm run init:local or configure a strong secret.')
const JWT_EXPIRES_IN = '7d'
const PORT = Number(sensitiveConfig.PORT || 3002)
const HOST = sensitiveConfig.HOST || '127.0.0.1'
// 🔧 支持自定义路由前缀，方便与其他服务共存
const API_PREFIX = process.env.API_PREFIX || '/api'           // API 前缀，如 /api1
const ADMIN_PATH = process.env.ADMIN_PATH || '/admin'         // 管理后台路径，如 /admin1

// 静态文件服务（管理后台）
app.get(ADMIN_PATH, (req, res) => res.redirect(`${ADMIN_PATH}/admin.html`))
app.use(ADMIN_PATH, express.static(path.join(__dirname, 'public')))

// SQLite 数据库初始化
const db = new sqlite3.Database(sensitiveConfig.DATABASE_PATH || path.join(__dirname, 'users.db'), (err) => {
    if (err) console.error('❌ 数据库连接失败:', err)
    else console.log('✅ SQLite 数据库已连接')
})

// 创建表
db.serialize(() => {
    // 用户表
    db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    avatar TEXT,
    role TEXT DEFAULT 'user',
    status TEXT DEFAULT 'active',
    device_fingerprint TEXT,
    max_devices INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login_at DATETIME,
    last_login_device TEXT
  )`)

    // 用户订阅表
    db.run(`CREATE TABLE IF NOT EXISTS user_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    subscription_type TEXT DEFAULT 'trial',
    expires_at DATETIME NOT NULL,
    trial_started_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`)

    // 设备绑定表
    db.run(`CREATE TABLE IF NOT EXISTS user_devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    device_fingerprint TEXT NOT NULL,
    device_name TEXT,
    is_active BOOLEAN DEFAULT 1,
    first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(user_id, device_fingerprint)
  )`)

    // 操作日志表
    db.run(`CREATE TABLE IF NOT EXISTS user_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    action TEXT NOT NULL,
    message TEXT,
    device_fingerprint TEXT,
    ip_address TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`)

    // 时长管理日志表
    db.run(`CREATE TABLE IF NOT EXISTS time_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    operator_id INTEGER,
    action TEXT NOT NULL,
    days_added INTEGER,
    new_expires_at DATETIME,
    reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`)

    // 为用户表添加积分字段（如果不存在）
    db.run(`ALTER TABLE users ADD COLUMN points INTEGER DEFAULT 0`, (err) => {
        if (err && !err.message.includes('duplicate column')) {
            console.log('积分字段已存在或添加失败')
        }
    })

    // 积分变动日志表
    db.run(`CREATE TABLE IF NOT EXISTS points_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    operator_id INTEGER,
    action TEXT NOT NULL,
    points_change INTEGER NOT NULL,
    points_after INTEGER NOT NULL,
    reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`)

    // 为用户表添加当前有效token字段（用于单点登录）
    db.run(`ALTER TABLE users ADD COLUMN current_token TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column')) {
            console.log('current_token字段已存在')
        }
    })

    // 多端在线会话表：同一账号允许多个token同时有效（保留最近10个）
    db.run(`CREATE TABLE IF NOT EXISTS user_tokens (
        user_id INTEGER NOT NULL,
        token TEXT PRIMARY KEY,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`)

    // 卡密表
    db.run(`CREATE TABLE IF NOT EXISTS cdkeys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        type TEXT DEFAULT 'standard',
        days INTEGER DEFAULT 30,
        video_quota INTEGER DEFAULT 100,
        max_devices INTEGER DEFAULT 1,
        status TEXT DEFAULT 'unused',
        used_by INTEGER,
        used_at DATETIME,
        created_by INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        note TEXT,
        FOREIGN KEY (used_by) REFERENCES users(id),
        FOREIGN KEY (created_by) REFERENCES users(id)
    )`)

    // 为卡密表添加设备限制字段
    db.run(`ALTER TABLE cdkeys ADD COLUMN max_devices INTEGER DEFAULT 1`, (err) => {
        if (err && !err.message.includes('duplicate column')) {
            console.log('max_devices字段已存在')
        }
    })

    // 为用户表添加视频配额字段
    db.run(`ALTER TABLE users ADD COLUMN video_quota INTEGER DEFAULT 0`, (err) => {
        if (err && !err.message.includes('duplicate column')) {
            console.log('video_quota字段已存在')
        }
    })

    // 为用户表添加视频使用量字段
    db.run(`ALTER TABLE users ADD COLUMN video_used INTEGER DEFAULT 0`, (err) => {
        if (err && !err.message.includes('duplicate column')) {
            console.log('video_used字段已存在')
        }
    })

    // 为用户表添加云端数字人禁用字段
    db.run(`ALTER TABLE users ADD COLUMN cloud_digital_human_disabled INTEGER DEFAULT 0`, (err) => {
        if (err && !err.message.includes('duplicate column')) {
            console.log('cloud_digital_human_disabled字段已存在')
        }
    })

    // 系统配置表（API Key等）
    db.run(`CREATE TABLE IF NOT EXISTS system_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        config_key TEXT UNIQUE NOT NULL,
        config_value TEXT NOT NULL,
        description TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_by TEXT
    )`)

    db.run(`CREATE TABLE IF NOT EXISTS generation_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        detail TEXT,
        device_fingerprint TEXT,
        ip_address TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`)

    const defaultConfigs = [
        ['aliyun_bailian_api_key', sensitiveConfig.ALIYUN_BAILIAN_API_KEY || '', '阿里云百炼 DashScope API Key'],
        ['aliyun_bailian_base_url', sensitiveConfig.ALIYUN_BAILIAN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1', '阿里云百炼 API Base URL'],
        ['aliyun_oss_access_key_id', sensitiveConfig.ALIYUN_OSS_ACCESS_KEY_ID || '', '阿里云 OSS AccessKey ID'],
        ['aliyun_oss_access_key_secret', sensitiveConfig.ALIYUN_OSS_ACCESS_KEY_SECRET || '', '阿里云 OSS AccessKey Secret'],
        ['aliyun_oss_bucket', sensitiveConfig.ALIYUN_OSS_BUCKET || '', '阿里云 OSS Bucket'],
        ['aliyun_oss_region', sensitiveConfig.ALIYUN_OSS_REGION || 'oss-cn-beijing', '阿里云 OSS Region'],
        ['volcengine_api_key', sensitiveConfig.VOLCENGINE_API_KEY || '', '火山引擎 API Key'],
        ['volcengine_model', sensitiveConfig.VOLCENGINE_MODEL || 'doubao-seed-2-0-lite-260215', '火山引擎默认模型'],
        ['runninghub_api_key', sensitiveConfig.RUNNINGHUB_API_KEY || '', 'RunningHub API Key'],
        ['runninghub_workflow_id_1', sensitiveConfig.RUNNINGHUB_WORKFLOW_ID_1 || '2044675464228245506', 'RunningHub 网络节点01 工作流ID（AI应用·数字人对口型）'],
        ['runninghub_workflow_id_2', sensitiveConfig.RUNNINGHUB_WORKFLOW_ID_2 || '1945645768491585538', 'RunningHub 网络节点02 工作流ID'],
        ['runninghub_workflow_id_3', sensitiveConfig.RUNNINGHUB_WORKFLOW_ID_3 || '1984199202748186626', 'RunningHub 网络节点03 工作流ID'],
        ['runninghub_workflow_id_4', sensitiveConfig.RUNNINGHUB_WORKFLOW_ID_4 || '2022323003056459778', 'RunningHub 网络节点04 工作流ID'],
        ['runninghub_workflow_id_5', sensitiveConfig.RUNNINGHUB_WORKFLOW_ID_5 || '1928389791241650178', 'RunningHub 网络节点05 工作流ID'],
        ['runninghub_workflow_id_6', sensitiveConfig.RUNNINGHUB_WORKFLOW_ID_6 || '1976590859607085058', 'RunningHub 网络节点06 工作流ID'],
        ['runninghub_workflow_id_7', sensitiveConfig.RUNNINGHUB_WORKFLOW_ID_7 || '1930534351568556033', 'RunningHub 网络节点07 工作流ID'],
        ['runninghub_workflow_id_8', sensitiveConfig.RUNNINGHUB_WORKFLOW_ID_8 || '2044675464228245506', 'RunningHub 网络节点08 工作流ID（AI应用·数字人对口型）'],
        ['runninghub_mode1_nodes', sensitiveConfig.RUNNINGHUB_MODE1_NODES || '{"videoNode":{"id":"228","fieldName":"video"},"audioNode":{"id":"125","fieldName":"audio"},"durationNode":{"id":"342","fieldName":"text","value":"0:{{audioDuration}}"},"fpsNode":{"id":"343","fieldName":"value","value":"30"},"widthNode":{"id":"345","fieldName":"value","value":"720"},"heightNode":{"id":"344","fieldName":"value","value":"1280"},"textNode":{"id":"347","fieldName":"text"}}', 'RunningHub 网络节点01 节点配置(JSON·数字人对口型)'],
        ['runninghub_mode2_nodes', sensitiveConfig.RUNNINGHUB_MODE2_NODES || '{"videoNode":{"id":"1","fieldName":"file"},"audioNode":{"id":"7","fieldName":"audio"},"textNode":{"id":"12","fieldName":"prompt"}}', 'RunningHub 网络节点02 节点配置(JSON)'],
        ['runninghub_mode3_nodes', sensitiveConfig.RUNNINGHUB_MODE3_NODES || '{"videoNode":{"id":"2","fieldName":"file"},"audioNode":{"id":"3","fieldName":"audio"}}', 'RunningHub 网络节点03 节点配置(JSON)'],
        ['runninghub_mode4_nodes', sensitiveConfig.RUNNINGHUB_MODE4_NODES || '{"videoNode":{"id":"31","fieldName":"video"},"audioNode":{"id":"13","fieldName":"audio"},"durationNode":{"id":"33","fieldName":"value"},"fpsNode":{"id":"36","fieldName":"int"},"widthNode":{"id":"43","fieldName":"int"},"heightNode":{"id":"46","fieldName":"int"}}', 'RunningHub 网络节点04 节点配置(JSON)'],
        ['runninghub_mode5_nodes', sensitiveConfig.RUNNINGHUB_MODE5_NODES || '{"videoNode":{"id":"1","fieldName":"file"},"audioNode":{"id":"4","fieldName":"audio"}}', 'RunningHub 网络节点05 节点配置(JSON)'],
        ['runninghub_mode6_nodes', sensitiveConfig.RUNNINGHUB_MODE6_NODES || '{"videoNode":{"id":"85","fieldName":"video"},"audioNode":{"id":"4","fieldName":"audio"}}', 'RunningHub 网络节点06 节点配置(JSON)'],
        ['runninghub_mode7_nodes', sensitiveConfig.RUNNINGHUB_MODE7_NODES || '{"videoNode":{"id":"3","fieldName":"file"},"audioNode":{"id":"2","fieldName":"audio"}}', 'RunningHub 网络节点07 节点配置(JSON)'],
        ['runninghub_mode8_nodes', sensitiveConfig.RUNNINGHUB_MODE8_NODES || '{"videoNode":{"id":"228","fieldName":"video"},"audioNode":{"id":"125","fieldName":"audio"},"durationNode":{"id":"342","fieldName":"text","value":"0:{{audioDuration}}"},"fpsNode":{"id":"343","fieldName":"value","value":"30"},"widthNode":{"id":"345","fieldName":"value","value":"720"},"heightNode":{"id":"344","fieldName":"value","value":"1280"},"textNode":{"id":"347","fieldName":"text"}}', 'RunningHub 网络节点08 节点配置(JSON·数字人对口型)'],
        ['runninghub_tts_workflow_id_t2', sensitiveConfig.RUNNINGHUB_TTS_WORKFLOW_ID_T2 || '2034189412338241537', 'RunningHub TTS T2 工作流ID'],
        ['runninghub_tts_nodes_t2', sensitiveConfig.RUNNINGHUB_TTS_NODES_T2 || '{"audioNode":"4","textNode":"7"}', 'RunningHub TTS T2 节点配置(JSON)'],
        ['runninghub_tts_workflow_id_t3', sensitiveConfig.RUNNINGHUB_TTS_WORKFLOW_ID_T3 || '2033381422974640130', 'RunningHub TTS T3 工作流ID'],
        ['runninghub_tts_nodes_t3', sensitiveConfig.RUNNINGHUB_TTS_NODES_T3 || '{"audioNode":"4","textNode":"7"}', 'RunningHub TTS T3 节点配置(JSON)'],
        ['runninghub_tts_workflow_id_t4', sensitiveConfig.RUNNINGHUB_TTS_WORKFLOW_ID_T4 || '', 'RunningHub TTS T4 工作流ID'],
        ['runninghub_tts_nodes_t4', sensitiveConfig.RUNNINGHUB_TTS_NODES_T4 || '{"audioNode":"80","textNode":"87"}', 'RunningHub TTS T4 节点配置(JSON)'],
        ['runninghub_tts_workflow_id_t5', sensitiveConfig.RUNNINGHUB_TTS_WORKFLOW_ID_T5 || '', 'RunningHub TTS T5 工作流ID'],
        ['runninghub_tts_nodes_t5', sensitiveConfig.RUNNINGHUB_TTS_NODES_T5 || '{"audioNode":"5","textNode":{"id":"6","fieldName":"prompt"}}', 'RunningHub TTS T5 节点配置(JSON)'],
        ['runninghub_tts_workflow_id_t6', sensitiveConfig.RUNNINGHUB_TTS_WORKFLOW_ID_T6 || '', 'RunningHub TTS T6 工作流ID'],
        ['runninghub_tts_nodes_t6', sensitiveConfig.RUNNINGHUB_TTS_NODES_T6 || '{"audioNode":"13","emotionAudioNode":"15","textNode":{"id":"14","fieldName":"value"}}', 'RunningHub TTS T6 节点配置(JSON)'],
        ['trial_duration_hours', '24', '默认试用时长（小时）'],
        ['runninghub_call_record_url', sensitiveConfig.RUNNINGHUB_CALL_RECORD_URL || 'https://www.runninghub.cn/call-api/call-record', 'RunningHub API调用记录地址'],
        ['model_providers', sensitiveConfig.MODEL_PROVIDERS || '[]', '推送模型供应商配置(JSON数组)']
    ]

    defaultConfigs.forEach(([key, value, desc]) => {
        db.run(
            `INSERT OR IGNORE INTO system_config (config_key, config_value, description) VALUES (?, ?, ?)`,
            [key, value, desc]
        )
    })

    // Public deployments never seed a predictable activation code.

})

// 辅助函数：记录日志
function logAction(userId, action, message, deviceFingerprint = null, ipAddress = null) {
    db.run(
        'INSERT INTO user_logs (user_id, action, message, device_fingerprint, ip_address) VALUES (?, ?, ?, ?, ?)',
        [userId, action, message, deviceFingerprint, ipAddress]
    )
}

// ==================== 管理员认证中间件 ====================
function adminAuth(req, res, next) {
    let token = null
    const authHeader = req.headers.authorization
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7)
    } else if (req.query && req.query.token) {
        token = req.query.token
    }

    if (!token) {
        return res.status(401).json({ success: false, message: '未提供认证Token' })
    }

    try {
        const payload = jwt.verify(token, JWT_SECRET)

        // 验证用户是否为管理员
        db.get('SELECT * FROM users WHERE id = ? AND role = ?', [payload.userId, 'admin'], (err, user) => {
            if (!user) {
                return res.status(403).json({ success: false, message: '无管理员权限' })
            }
            if (user.status !== 'active') {
                return res.status(403).json({ success: false, message: '账户已被禁用' })
            }
            req.adminUser = user
            next()
        })
    } catch (error) {
        return res.status(401).json({ success: false, message: 'Token无效或已过期' })
    }
}

// Trusted desktop clients require an active account before receiving provider settings.
function clientAuth(req, res, next) {
    const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null
    if (!token) return res.status(401).json({ success: false, message: '请先登录' })
    try {
        const payload = jwt.verify(token, JWT_SECRET)
        db.get('SELECT id, role, status FROM users WHERE id = ?', [payload.userId], (err, user) => {
            if (err) return res.status(500).json({ success: false, message: '认证查询失败' })
            if (!user || user.status !== 'active') return res.status(403).json({ success: false, message: '账号不可用' })
            req.clientUser = user
            next()
        })
    } catch { return res.status(401).json({ success: false, message: 'Token无效或已过期' }) }
}

// Account-owned operations must not accept another user's identifier.
function accountScope(req, res, next) {
    const requested = req.params.userId ?? req.body.user_id ?? req.body.userId
    if (requested == null || Number(requested) !== req.clientUser.id) return res.status(403).json({ success: false, message: '只能操作当前账号' })
    next()
}

// ==================== 用户注册 ====================
app.post(`${API_PREFIX}/register`, async (req, res) => {
    const { username, email, password, device_fingerprint, cdkey } = req.body
    const clientIp = req.ip || req.connection.remoteAddress

    if (!username || !email || !password) {
        return res.json({ success: false, message: '用户名、手机号和密码不能为空' })
    }

    // 检查用户名或邮箱是否已存在
    db.get('SELECT id FROM users WHERE username = ? OR email = ?', [username, email], async (err, row) => {
        if (row) {
            return res.json({ success: false, message: '用户名或手机号已存在' })
        }

        try {
            // 检查是否为首个用户（首个用户自动成为管理员）
            db.get('SELECT COUNT(*) as count FROM users', async (err, countRow) => {
                const isFirstUser = countRow?.count === 0
                const role = isFirstUser ? 'admin' : 'user'

                // 加密密码
                const salt = await bcrypt.genSalt(10)
                const hashedPassword = await bcrypt.hash(password, salt)

                if (isFirstUser) {
                    // 首个用户不需要卡密，直接创建管理员账号
                    db.run(
                        `INSERT INTO users (username, email, password, role, device_fingerprint, video_quota, video_used, max_devices) 
           VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
                        [username, email, hashedPassword, role, device_fingerprint, 9999, 5],
                        function (err) {
                            if (err) {
                                return res.json({ success: false, message: '注册失败: ' + err.message })
                            }

                            const userId = this.lastID

                            // 给管理员一个永久订阅（100年）
                            const adminExpiresAt = new Date()
                            adminExpiresAt.setFullYear(adminExpiresAt.getFullYear() + 100)

                            db.run(
                                `INSERT INTO user_subscriptions (user_id, subscription_type, expires_at) 
                   VALUES (?, 'admin', ?)`,
                                [userId, adminExpiresAt.toISOString()]
                            )

                            // 记录设备
                            if (device_fingerprint) {
                                db.run(
                                    `INSERT INTO user_devices (user_id, device_fingerprint, device_name) VALUES (?, ?, ?)`,
                                    [userId, device_fingerprint, '首次注册设备']
                                )
                            }

                            // 记录日志
                            logAction(userId, 'register', '用户注册成功，自动成为管理员', device_fingerprint, clientIp)

                            const token = jwt.sign(
                                { userId, username, email, role },
                                JWT_SECRET,
                                { expiresIn: JWT_EXPIRES_IN }
                            )

                            res.json({
                                success: true,
                                token,
                                user: { id: userId, username, email, role, video_quota: 9999 },
                                subscription: {
                                    type: 'admin',
                                    expires_at: adminExpiresAt.toISOString()
                                },
                                message: '注册成功！您是首个用户，已自动成为管理员' 
                            })
                        }
                    )
                } else {
                    // 非首个用户需要卡密
                    if (!cdkey) {
                        return res.json({ success: false, message: '请输入卡密' })
                    }

                    // 验证卡密（去除前后空格，避免复制时带入空格）
                    const trimmedCdkey = cdkey.trim()
                    db.get('SELECT * FROM cdkeys WHERE code = ? AND status = ?', [trimmedCdkey, 'unused'], async (err, cdkeyRecord) => {
                        if (!cdkeyRecord) {
                            return res.json({ success: false, message: '卡密无效或已被使用' })
                        }

                        // 创建用户（包含视频配额和设备限制）
                        db.run(
                            `INSERT INTO users (username, email, password, role, device_fingerprint, video_quota, video_used, max_devices) 
           VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
                            [username, email, hashedPassword, role, device_fingerprint, cdkeyRecord.video_quota, cdkeyRecord.max_devices || 1],
                            function (err) {
                                if (err) {
                                    return res.json({ success: false, message: '注册失败: ' + err.message })
                                }

                                const userId = this.lastID

                                // 根据卡密天数创建订阅
                                const expiresAt = new Date()
                                expiresAt.setDate(expiresAt.getDate() + cdkeyRecord.days)

                                db.run(
                                    `INSERT INTO user_subscriptions (user_id, subscription_type, expires_at) 
                   VALUES (?, 'cdkey', ?)`,
                                    [userId, expiresAt.toISOString()]
                                )

                                // 标记卡密为已使用
                                db.run(
                                    `UPDATE cdkeys SET status = 'used', used_by = ?, used_at = CURRENT_TIMESTAMP WHERE id = ?`,
                                    [userId, cdkeyRecord.id]
                                )

                                // 记录设备
                                if (device_fingerprint) {
                                        db.run(
                                            `INSERT INTO user_devices (user_id, device_fingerprint, device_name) VALUES (?, ?, ?)`,
                                            [userId, device_fingerprint, '首次注册设备']
                                        )
                                    }

                                    // 记录日志
                                    logAction(userId, 'register', `用户注册成功，使用卡密: ${trimmedCdkey}`, device_fingerprint, clientIp)
                                    logAction(userId, 'cdkey_use', `使用卡密: ${trimmedCdkey}`, device_fingerprint, clientIp)

                                    const token = jwt.sign(
                                        { userId, username, email, role },
                                        JWT_SECRET,
                                        { expiresIn: JWT_EXPIRES_IN }
                                    )

                                    res.json({
                                        success: true,
                                        token,
                                        user: { id: userId, username, email, role, video_quota: cdkeyRecord.video_quota },
                                        subscription: {
                                            type: 'cdkey',
                                            expires_at: expiresAt.toISOString()
                                        },
                                        message: `注册成功！获得 ${cdkeyRecord.days} 天使用期和 ${cdkeyRecord.video_quota} 次配额（语音生成/数字人/克隆音色共用）`
                                    })
                                })
                    })
                }
            })
        } catch (error) {
            res.json({ success: false, message: '注册失败: ' + error.message })
        }
    })
})

// ==================== 用户登录 ====================
app.post(`${API_PREFIX}/login`, async (req, res) => {
    const { email, password, device_fingerprint } = req.body
    const clientIp = req.ip || req.connection.remoteAddress

    if (!email || !password) {
        return res.json({ success: false, message: '手机号和密码不能为空' })
    }

    db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
        if (!user) {
            logAction(null, 'login_failed', `登录失败: 手机号 ${email} 不存在`, null, clientIp)
            return res.json({ success: false, message: '手机号或密码错误' })
        }

        // 验证密码
        const isPasswordValid = await bcrypt.compare(password, user.password)
        if (!isPasswordValid) {
            logAction(user.id, 'login_failed', '登录失败: 密码错误', null, clientIp)
            return res.json({ success: false, message: '手机号或密码错误' })
        }

        // 检查账户状态
        if (user.status !== 'active') {
            return res.json({ success: false, message: '账户已被禁用，请联系管理员' })
        }

        // 单点登录：直接完成登录，新登录会使旧token失效
        completeLogin(user, null, clientIp, res)
    })
})

function completeLogin(user, device_fingerprint, clientIp, res) {
    // 更新最后登录时间
    const now = new Date().toISOString()
    console.log(`[Login] 用户 ${user.username} 登录成功，更新 last_login_at: ${now}`)

    // 获取订阅信息
    db.get('SELECT * FROM user_subscriptions WHERE user_id = ?', [user.id], (err, subscription) => {
        // 生成 JWT Token
        const token = jwt.sign(
            { userId: user.id, username: user.username, email: user.email, role: user.role },
            JWT_SECRET,
            { expiresIn: JWT_EXPIRES_IN }
        )

        // 多端在线：记录本次登录token到会话表，其他设备的会话保持有效（每个账号最多保留10个）
        db.run(
            'INSERT OR REPLACE INTO user_tokens (user_id, token, created_at) VALUES (?, ?, ?)',
            [user.id, token, now]
        )
        db.run(
            `DELETE FROM user_tokens WHERE user_id = ? AND token NOT IN (
                SELECT token FROM user_tokens WHERE user_id = ? ORDER BY created_at DESC LIMIT 10
            )`,
            [user.id, user.id]
        )

        // 记录最近一次登录的token（仅作展示/兼容用途，踢人会话逻辑见 user_tokens 表）
        db.run(
            'UPDATE users SET last_login_at = ?, current_token = ?, updated_at = ? WHERE id = ?',
            [now, token, now, user.id]
        )

        logAction(user.id, 'login_success', '登录成功', null, clientIp)

        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                role: user.role,
                status: user.status,
                points: user.points || 0,
                cloud_digital_human_disabled: user.cloud_digital_human_disabled || 0
            },
            subscription: subscription || null
        })
    })
}

// ==================== 验证Token ====================
app.post(`${API_PREFIX}/verify`, (req, res) => {
    const { token } = req.body

    if (!token) {
        return res.json({ valid: false, message: 'Token不存在' })
    }

    try {
        const payload = jwt.verify(token, JWT_SECRET)

        // 获取用户最新信息
        db.get('SELECT * FROM users WHERE id = ?', [payload.userId], (err, user) => {
            if (!user) {
                return res.json({ valid: false, message: '用户不存在' })
            }

            if (user.status !== 'active') {
                return res.json({ valid: false, message: '账户已被禁用', disabled: true })
            }

            // 多端在线检查：token命中会话表即有效；不在表中且不等于最近token才判定被踢
            db.get('SELECT 1 FROM user_tokens WHERE user_id = ? AND token = ?', [user.id, token], (err, sessionRow) => {
                if (!sessionRow && user.current_token && user.current_token !== token) {
                    return res.json({
                        valid: false,
                        message: '您的账号已在其他设备登录，当前会话已失效',
                        kicked: true
                    })
                }

                // 获取订阅信息
                db.get('SELECT * FROM user_subscriptions WHERE user_id = ?', [user.id], (err, subscription) => {
                const now = new Date()
                const expiresAt = subscription ? new Date(subscription.expires_at) : null
                const isExpired = expiresAt ? now > expiresAt : true
                const remainingMs = expiresAt ? expiresAt - now : 0
                const remainingDays = Math.ceil(remainingMs / (1000 * 60 * 60 * 24))

                res.json({
                    valid: true,
                    user: {
                        id: user.id,
                        username: user.username,
                        email: user.email,
                        role: user.role,
                        points: user.points || 0,
                        cloud_digital_human_disabled: user.cloud_digital_human_disabled || 0,
                        video_quota: user.video_quota || 0,
                        video_used: user.video_used || 0
                    },
                    subscription: subscription,
                    isExpired: isExpired,
                    remainingDays: remainingDays > 0 ? remainingDays : 0
                })
                })
            })
        })
    } catch (error) {
        res.json({ valid: false, message: 'Token无效或已过期' })
    }
})

// ==================== 检查订阅状态 ====================
app.post(`${API_PREFIX}/subscription/check`, clientAuth, accountScope, (req, res) => {
    const { user_id } = req.body

    db.get('SELECT * FROM user_subscriptions WHERE user_id = ?', [user_id], (err, subscription) => {
        if (!subscription) {
            return res.json({ hasAccess: false, isExpired: true })
        }

        const now = new Date()
        const expiresAt = new Date(subscription.expires_at)
        const isExpired = now > expiresAt
        const remainingMs = expiresAt - now
        const remainingDays = Math.ceil(remainingMs / (1000 * 60 * 60 * 24))

        res.json({
            hasAccess: !isExpired,
            isExpired: isExpired,
            expiresAt: subscription.expires_at,
            remainingDays: remainingDays > 0 ? remainingDays : 0,
            subscription: subscription
        })
    })
})

// ==================== 管理员：用户列表 ====================
app.get(`${API_PREFIX}/admin/users`, adminAuth, (req, res) => {
    const page = parseInt(req.query.page) || 1
    const limit = parseInt(req.query.limit) || 20
    const offset = (page - 1) * limit
    const search = req.query.search || ''

    let whereClause = ''
    let params = []

    if (search) {
        whereClause = 'WHERE (u.username LIKE ? OR u.email LIKE ?)'
        params.push(`%${search}%`, `%${search}%`)
    }

    db.all(`
    SELECT u.*, s.subscription_type, s.expires_at,
           (SELECT COUNT(*) FROM user_devices WHERE user_id = u.id) as device_count
    FROM users u
    LEFT JOIN user_subscriptions s ON u.id = s.user_id
    ${whereClause}
    ORDER BY u.created_at DESC
    LIMIT ? OFFSET ?
  `, [...params, limit, offset], (err, rows) => {
        if (err) {
            return res.json({ success: false, error: err.message })
        }
        // 移除密码字段
        const users = rows.map(u => {
            const { password, ...userWithoutPassword } = u
            return userWithoutPassword
        })

        db.get(`SELECT COUNT(*) as total FROM users u ${whereClause}`, params, (err2, countResult) => {
            res.json({
                success: true,
                users,
                pagination: {
                    page,
                    limit,
                    total: countResult?.total || 0
                }
            })
        })
    })
})

// ==================== 管理员：调整时长和配额 ====================
app.post(`${API_PREFIX}/admin/add-time`, adminAuth, (req, res) => {
    const { user_id, days, reason, quota_change } = req.body
    const addDays = parseInt(days) || 0
    const addHours = addDays * 24
    const quotaChange = parseInt(quota_change) || 0

    db.get('SELECT * FROM user_subscriptions WHERE user_id = ?', [user_id], (err, subscription) => {
        let newExpiresAt
        if (subscription) {
            const currentExpires = new Date(subscription.expires_at)
            const now = new Date()
            const baseDate = currentExpires > now ? currentExpires : now
            newExpiresAt = new Date(baseDate)
            newExpiresAt.setHours(newExpiresAt.getHours() + addHours)

            db.run(
                'UPDATE user_subscriptions SET expires_at = ?, subscription_type = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?',
                [newExpiresAt.toISOString(), 'pro', user_id]
            )
        } else {
            newExpiresAt = new Date()
            newExpiresAt.setHours(newExpiresAt.getHours() + addHours)

            db.run(
                'INSERT INTO user_subscriptions (user_id, subscription_type, expires_at) VALUES (?, ?, ?)',
                [user_id, 'pro', newExpiresAt.toISOString()]
            )
        }

        // 调整配额
        if (quotaChange !== 0) {
            db.get('SELECT video_quota, video_used FROM users WHERE id = ?', [user_id], (err, user) => {
                if (user) {
                    let newQuota = user.video_quota + quotaChange
                    if (newQuota < user.video_used) newQuota = user.video_used // 配额不能低于已用数
                    db.run('UPDATE users SET video_quota = ? WHERE id = ?', [newQuota, user_id])
                }
            })
        }

        db.run(
            'INSERT INTO time_logs (user_id, action, days_added, new_expires_at, reason) VALUES (?, ?, ?, ?, ?)',
            [user_id, 'add_time', addHours, newExpiresAt.toISOString(), reason || '管理员调整']
        )

        res.json({
            success: true,
            message: `成功调整：时长${addDays >= 0 ? '+' : ''}${addDays}天，配额${quotaChange >= 0 ? '+' : ''}${quotaChange}`,
            newExpiresAt: newExpiresAt.toISOString()
        })
    })
})

// ==================== 管理员：导出用户 ====================
app.get(`${API_PREFIX}/admin/users/export`, adminAuth, (req, res) => {
    const search = req.query.search || ''
    const status = req.query.status || ''

    let whereClause = ''
    let params = []
    const conditions = []

    if (search) {
        conditions.push('(u.username LIKE ? OR u.email LIKE ?)')
        params.push(`%${search}%`, `%${search}%`)
    }
    if (status && ['active', 'suspended'].includes(status)) {
        conditions.push('u.status = ?')
        params.push(status)
    }
    if (conditions.length > 0) {
        whereClause = 'WHERE ' + conditions.join(' AND ')
    }

    db.all(`
    SELECT u.id, u.username, u.email, u.role, u.status, u.video_quota, u.video_used,
           u.cloud_digital_human_disabled, u.last_login_at, u.created_at,
           s.subscription_type, s.expires_at,
           (SELECT COUNT(*) FROM user_devices WHERE user_id = u.id) as device_count
    FROM users u
    LEFT JOIN user_subscriptions s ON u.id = s.user_id
    ${whereClause}
    ORDER BY u.created_at DESC
    `, params, (err, users) => {
        if (err) return res.json({ success: false, error: err.message })

        const csv = [
            ['ID', '用户名', '手机号', '角色', '状态', '时长到期', '配额总量', '配额已用', '配额剩余', '云端数字人', '设备数', '最后登录', '注册时间'].join(','),
            ...users.map(u => {
                const quotaRemaining = (u.video_quota || 0) - (u.video_used || 0)
                const expiresAt = u.expires_at ? new Date(u.expires_at).toLocaleString('zh-CN') : '无'
                const cloudStatus = u.cloud_digital_human_disabled ? '已关闭' : '已开启'
                const statusText = u.status === 'active' ? '正常' : '禁用'
                return [
                    u.id,
                    u.username,
                    u.email,
                    u.role,
                    statusText,
                    expiresAt,
                    u.video_quota || 0,
                    u.video_used || 0,
                    quotaRemaining,
                    cloudStatus,
                    u.device_count || 0,
                    u.last_login_at ? new Date(u.last_login_at).toLocaleString('zh-CN') : '',
                    u.created_at ? new Date(u.created_at).toLocaleString('zh-CN') : ''
                ].map(v => `"${v}"`).join(',')
            })
        ].join('\n')

        res.setHeader('Content-Type', 'text/csv; charset=utf-8')
        res.setHeader('Content-Disposition', 'attachment; filename=users.csv')
        res.send('\ufeff' + csv)
    })
})

// ==================== 管理员：删除用户 ====================
app.post(`${API_PREFIX}/admin/user/delete`, adminAuth, (req, res) => {
    const { user_id } = req.body

    // 不能删除管理员
    db.get('SELECT role FROM users WHERE id = ?', [user_id], (err, user) => {
        if (err) return res.json({ success: false, error: err.message })
        if (!user) return res.json({ success: false, error: '用户不存在' })
        if (user.role === 'admin') return res.json({ success: false, error: '不能删除管理员账号' })

        // 删除关联数据
        db.serialize(() => {
            db.run('DELETE FROM user_subscriptions WHERE user_id = ?', [user_id])
            db.run('DELETE FROM user_devices WHERE user_id = ?', [user_id])
            db.run('DELETE FROM time_logs WHERE user_id = ?', [user_id])
            db.run('DELETE FROM generation_logs WHERE user_id = ?', [user_id])
            db.run('DELETE FROM users WHERE id = ?', [user_id], (err) => {
                if (err) return res.json({ success: false, error: err.message })
                res.json({ success: true, message: '用户已删除' })
            })
        })
    })
})

// ==================== 管理员：禁用/启用用户 ====================
app.post(`${API_PREFIX}/admin/user/status`, adminAuth, (req, res) => {
    const { user_id, status } = req.body

    db.run('UPDATE users SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [status, user_id], (err) => {
        if (err) {
            return res.json({ success: false, error: err.message })
        }
        logAction(user_id, 'status_change', `账户状态变更为: ${status}`)
        res.json({ success: true, message: `用户状态已更新为: ${status}` })
    })
})

// ==================== 管理员：重置密码 ====================
app.post(`${API_PREFIX}/admin/user/reset-password`, adminAuth, async (req, res) => {
    const { user_id, new_password } = req.body

    if (!user_id || !new_password) {
        return res.json({ success: false, message: '用户ID和新密码不能为空' })
    }

    if (new_password.length < 6) {
        return res.json({ success: false, message: '密码长度至少6位' })
    }

    try {
        // 加密新密码
        const salt = await bcrypt.genSalt(10)
        const hashedPassword = await bcrypt.hash(new_password, salt)

        db.run(
            'UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [hashedPassword, user_id],
            (err) => {
                if (err) {
                    return res.json({ success: false, error: err.message })
                }
                logAction(user_id, 'password_reset', '管理员重置了密码')
                console.log(`[Admin] 用户ID ${user_id} 密码已重置`)
                res.json({ success: true, message: '密码重置成功' })
            }
        )
    } catch (error) {
        res.json({ success: false, message: '密码重置失败: ' + error.message })
    }
})

// 修改用户名
app.post(`${API_PREFIX}/admin/user/rename`, adminAuth, (req, res) => {
    const { user_id, new_username } = req.body

    if (!user_id || !new_username) {
        return res.json({ success: false, message: '用户ID和新用户名不能为空' })
    }

    if (new_username.length < 2 || new_username.length > 30) {
        return res.json({ success: false, message: '用户名长度需在2-30位之间' })
    }

    // 检查用户名是否已存在
    db.get('SELECT id FROM users WHERE username = ? AND id != ?', [new_username, user_id], (err, existingUser) => {
        if (err) {
            return res.json({ success: false, message: '查询失败: ' + err.message })
        }
        if (existingUser) {
            return res.json({ success: false, message: '该用户名已存在' })
        }

        db.run(
            'UPDATE users SET username = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [new_username, user_id],
            (err) => {
                if (err) {
                    return res.json({ success: false, message: '修改失败: ' + err.message })
                }
                logAction(user_id, 'username_rename', `管理员修改用户名为: ${new_username}`)
                console.log(`[Admin] 用户ID ${user_id} 用户名已修改为: ${new_username}`)
                res.json({ success: true, message: '用户名修改成功' })
            }
        )
    })
})

// ==================== 管理员：解绑设备 ====================
app.post(`${API_PREFIX}/admin/device/unbind`, adminAuth, (req, res) => {
    const { user_id, device_fingerprint } = req.body

    if (device_fingerprint) {
        db.run('DELETE FROM user_devices WHERE user_id = ? AND device_fingerprint = ?', [user_id, device_fingerprint], (err) => {
            if (err) return res.json({ success: false, error: err.message })
            logAction(user_id, 'device_unbind', `设备已解绑: ${device_fingerprint}`)
            res.json({ success: true, message: '设备已解绑' })
        })
    } else {
        // 解绑所有设备
        db.run('DELETE FROM user_devices WHERE user_id = ?', [user_id], (err) => {
            if (err) return res.json({ success: false, error: err.message })
            logAction(user_id, 'device_unbind_all', '所有设备已解绑')
            res.json({ success: true, message: '所有设备已解绑' })
        })
    }
})

// ==================== 管理员：获取用户设备列表 ====================
app.get(`${API_PREFIX}/admin/user/:userId/devices`, adminAuth, (req, res) => {
    const userId = req.params.userId
    db.all('SELECT * FROM user_devices WHERE user_id = ? ORDER BY last_seen_at DESC', [userId], (err, devices) => {
        if (err) return res.json({ success: false, error: err.message })
        res.json({ success: true, devices })
    })
})

// ==================== 客户端：上报生成记录 ====================
app.post(`${API_PREFIX}/user/generation-log`, clientAuth, accountScope, (req, res) => {
    const { userId, type, detail } = req.body
    const validTypes = ['script', 'voice', 'video', 'subtitle']
    if (!type || !validTypes.includes(type)) {
        return res.json({ success: false, message: '无效的生成类型' })
    }
    if (!userId) {
        return res.json({ success: false, message: '缺少userId' })
    }
    const ip = req.ip || req.connection.remoteAddress
    const fingerprint = req.headers['x-device-fingerprint'] || null

    // 记录日志
    db.run(
        'INSERT INTO generation_logs (user_id, type, detail, device_fingerprint, ip_address) VALUES (?, ?, ?, ?, ?)',
        [userId, type, detail || '', fingerprint, ip],
        function(err) {
            if (err) return res.json({ success: false, message: err.message })

            // 语音(TTS/克隆)和视频(数字人对口型)类型扣减配额
            if (type === 'voice' || type === 'video') {
                const quotaType = type === 'voice' ? 'tts' : 'digital_human'
                const typeLabels = { tts: '文字生成语音', digital_human: '数字人对口型' }
                db.get('SELECT video_quota, video_used FROM users WHERE id = ?', [userId], (err, user) => {
                    if (user && user.video_quota > 0 && user.video_used < user.video_quota) {
                        db.run('UPDATE users SET video_used = video_used + 1 WHERE id = ?', [userId], (err) => {
                            if (!err) {
                                db.run(
                                    'INSERT INTO generation_logs (user_id, type, detail) VALUES (?, ?, ?)',
                                    [userId, 'quota_use', `${typeLabels[quotaType]} 消耗1次配额`]
                                )
                            }
                        })
                    }
                })
            }

            res.json({ success: true })
        }
    )
})

// ==================== 管理员：生成记录统计 ====================
app.get(`${API_PREFIX}/admin/generation-stats`, adminAuth, (req, res) => {
    const userId = req.query.userId
    let sql, params
    if (userId) {
        sql = `SELECT type, COUNT(*) as count FROM generation_logs WHERE user_id = ? GROUP BY type`
        params = [userId]
    } else {
        sql = `SELECT type, COUNT(*) as count FROM generation_logs GROUP BY type`
    }
    db.all(sql, params, (err, rows) => {
        if (err) return res.json({ success: false, error: err.message })
        const result = { script: 0, voice: 0, video: 0, subtitle: 0, total: 0 }
        rows.forEach(r => {
            result[r.type] = r.count
            result.total += r.count
        })
        res.json({ success: true, stats: result })
    })
})

app.get(`${API_PREFIX}/admin/generation-logs`, adminAuth, (req, res) => {
    const { userId, type, page = 1, limit = 50 } = req.query
    const offset = (page - 1) * limit
    let where = '1=1'
    const params = []
    if (userId) { where += ' AND gl.user_id = ?'; params.push(userId) }
    if (type) { where += ' AND gl.type = ?'; params.push(type) }
    db.all(
        `SELECT gl.*, u.username FROM generation_logs gl LEFT JOIN users u ON gl.user_id = u.id WHERE ${where} ORDER BY gl.created_at DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset],
        (err, logs) => {
            if (err) return res.json({ success: false, error: err.message })
            db.get(`SELECT COUNT(*) as total FROM generation_logs gl WHERE ${where}`, params, (err2, countRow) => {
                res.json({ success: true, logs, total: countRow?.total || 0 })
            })
        }
    )
})

// ==================== 管理员：统计信息 ====================
app.get(`${API_PREFIX}/admin/stats`, adminAuth, (req, res) => {
    db.get(`
    SELECT
      (SELECT COUNT(*) FROM users) as total_users,
      (SELECT COUNT(*) FROM users WHERE status = 'active') as active_users,
      (SELECT COUNT(*) FROM users WHERE role = 'admin') as admin_count,
      (SELECT COUNT(*) FROM user_subscriptions WHERE expires_at > datetime('now')) as valid_subscriptions,
      (SELECT COUNT(*) FROM user_subscriptions WHERE expires_at <= datetime('now')) as expired_subscriptions,
      (SELECT COUNT(*) FROM user_devices) as total_devices
  `, [], (err, stats) => {
        if (err) return res.json({ success: false, error: err.message })
        res.json({ success: true, stats })
    })
})

// ==================== 管理员：创建子管理员 ====================
app.post(`${API_PREFIX}/admin/create-admin`, adminAuth, async (req, res) => {
    const { username, email, password } = req.body
    const clientIp = req.ip || req.connection.remoteAddress

    if (!username || !email || !password) {
        return res.json({ success: false, message: '用户名、手机号和密码不能为空' })
    }

    if (password.length < 6) {
        return res.json({ success: false, message: '密码长度至少6位' })
    }

    // 检查用户名或邮箱是否已存在
    db.get('SELECT id FROM users WHERE username = ? OR email = ?', [username, email], async (err, row) => {
        if (row) {
            return res.json({ success: false, message: '用户名或手机号已存在' })
        }

        try {
            // 加密密码
            const salt = await bcrypt.genSalt(10)
            const hashedPassword = await bcrypt.hash(password, salt)

            // 创建管理员用户
            db.run(
                `INSERT INTO users (username, email, password, role, status) VALUES (?, ?, ?, 'admin', 'active')`,
                [username, email, hashedPassword],
                function (err) {
                    if (err) {
                        return res.json({ success: false, message: '创建失败: ' + err.message })
                    }

                    const userId = this.lastID

                    // 给管理员一个永久订阅（100年）
                    const adminExpiresAt = new Date()
                    adminExpiresAt.setFullYear(adminExpiresAt.getFullYear() + 100)

                    db.run(
                        `INSERT INTO user_subscriptions (user_id, subscription_type, expires_at) VALUES (?, 'admin', ?)`,
                        [userId, adminExpiresAt.toISOString()]
                    )

                    logAction(req.adminUser.id, 'create_admin', `创建了子管理员: ${username}`, null, clientIp)
                    console.log(`[Admin] ${req.adminUser.username} 创建了子管理员: ${username}`)

                    res.json({
                        success: true,
                        message: `子管理员 ${username} 创建成功`,
                        user: { id: userId, username, email, role: 'admin' }
                    })
                }
            )
        } catch (error) {
            res.json({ success: false, message: '创建失败: ' + error.message })
        }
    })
})

// ==================== 管理员：修改用户角色 ====================
app.post(`${API_PREFIX}/admin/user/role`, adminAuth, (req, res) => {
    const { user_id, role } = req.body

    if (!['user', 'admin'].includes(role)) {
        return res.json({ success: false, message: '无效的角色' })
    }

    // 不能修改自己的角色
    if (user_id === req.adminUser.id) {
        return res.json({ success: false, message: '不能修改自己的角色' })
    }

    db.run('UPDATE users SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [role, user_id], (err) => {
        if (err) {
            return res.json({ success: false, error: err.message })
        }
        logAction(user_id, 'role_change', `角色变更为: ${role}`)
        console.log(`[Admin] ${req.adminUser.username} 将用户ID ${user_id} 的角色改为: ${role}`)
        res.json({ success: true, message: `用户角色已更新为: ${role}` })
    })
})

// ==================== 管理员：修改用户积分 ====================
app.post(`${API_PREFIX}/admin/points/modify`, adminAuth, (req, res) => {
    const { user_id, points_change, reason } = req.body

    if (!user_id || points_change === undefined || points_change === 0) {
        return res.json({ success: false, message: '用户ID和积分变动不能为空' })
    }

    const pointsChange = parseInt(points_change)

    // 获取用户当前积分
    db.get('SELECT id, username, points FROM users WHERE id = ?', [user_id], (err, user) => {
        if (!user) {
            return res.json({ success: false, message: '用户不存在' })
        }

        const currentPoints = user.points || 0
        const newPoints = currentPoints + pointsChange

        if (newPoints < 0) {
            return res.json({ success: false, message: '积分不足，无法扣减' })
        }

        // 更新积分
        db.run('UPDATE users SET points = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [newPoints, user_id], (err) => {
            if (err) {
                return res.json({ success: false, error: err.message })
            }

            // 记录积分日志
            db.run(
                'INSERT INTO points_logs (user_id, operator_id, action, points_change, points_after, reason) VALUES (?, ?, ?, ?, ?, ?)',
                [user_id, req.adminUser.id, pointsChange > 0 ? 'add' : 'deduct', pointsChange, newPoints, reason || (pointsChange > 0 ? '管理员添加' : '管理员扣减')]
            )

            logAction(user_id, 'points_change', `积分变动: ${pointsChange > 0 ? '+' : ''}${pointsChange}，当前: ${newPoints}`)
            console.log(`[Admin] ${req.adminUser.username} 将用户 ${user.username} 的积分变动 ${pointsChange > 0 ? '+' : ''}${pointsChange}，当前: ${newPoints}`)

            res.json({
                success: true,
                message: `积分${pointsChange > 0 ? '增加' : '扣减'}成功`,
                pointsChange: pointsChange,
                newPoints: newPoints
            })
        })
    })
})

// ==================== 管理员：查询用户积分日志 ====================
app.get(`${API_PREFIX}/admin/points/logs/:userId`, adminAuth, (req, res) => {
    const userId = req.params.userId

    db.all(
        `SELECT pl.*, u.username as operator_name 
         FROM points_logs pl 
         LEFT JOIN users u ON pl.operator_id = u.id 
         WHERE pl.user_id = ? 
         ORDER BY pl.created_at DESC 
         LIMIT 50`,
        [userId],
        (err, logs) => {
            if (err) return res.json({ success: false, error: err.message })
            res.json({ success: true, logs })
        }
    )
})

// ==================== 管理员：查询用户登录日志 ====================
app.get(`${API_PREFIX}/admin/logs/user/:userId`, adminAuth, (req, res) => {
    const userId = req.params.userId

    db.all(
        `SELECT * FROM user_logs 
         WHERE user_id = ? 
         ORDER BY created_at DESC 
         LIMIT 100`,
        [userId],
        (err, logs) => {
            if (err) return res.json({ success: false, error: err.message })
            res.json({ success: true, logs })
        }
    )
})

// ==================== 管理员：查询所有管理员操作日志 ====================
app.get(`${API_PREFIX}/admin/logs/admin-actions`, adminAuth, (req, res) => {
    db.all(
        `SELECT ul.*, u.username as target_username, admin.username as operator_username
         FROM user_logs ul
         LEFT JOIN users u ON ul.user_id = u.id
         LEFT JOIN users admin ON ul.ip_address = CAST(admin.id AS TEXT)
         WHERE ul.action IN ('create_admin', 'status_change', 'password_reset', 'role_change', 'points_change', 'device_unbind', 'device_unbind_all')
         ORDER BY ul.created_at DESC
         LIMIT 200`,
        [],
        (err, logs) => {
            if (err) return res.json({ success: false, error: err.message })
            res.json({ success: true, logs })
        }
    )
})

// ==================== 管理员：查询所有日志（综合） ====================
app.get(`${API_PREFIX}/admin/logs/all`, adminAuth, (req, res) => {
    const page = parseInt(req.query.page) || 1
    const limit = parseInt(req.query.limit) || 50
    const offset = (page - 1) * limit
    const actionFilter = req.query.action || ''

    let whereClause = ''
    let params = []

    if (actionFilter) {
        whereClause = 'WHERE ul.action = ?'
        params.push(actionFilter)
    }

    db.all(
        `SELECT ul.*, u.username 
         FROM user_logs ul
         LEFT JOIN users u ON ul.user_id = u.id
         ${whereClause}
         ORDER BY ul.created_at DESC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset],
        (err, logs) => {
            if (err) return res.json({ success: false, error: err.message })
            res.json({ success: true, logs, page, limit })
        }
    )
})

// ==================== 设备签到 ====================
app.post(`${API_PREFIX}/device/checkin`, clientAuth, accountScope, (req, res) => {
    const { user_id, device_fingerprint } = req.body

    db.run(
        'UPDATE user_devices SET last_seen_at = CURRENT_TIMESTAMP WHERE user_id = ? AND device_fingerprint = ?',
        [user_id, device_fingerprint],
        (err) => {
            if (err) return res.json({ success: false, error: err.message })
            res.json({ success: true, message: '签到成功' })
        }
    )
})

// ==================== 客户端：获取系统公开配置（API Key等） ====================
app.get(`${API_PREFIX}/system/config/public`, (req, res, next) => {
    if (!req.headers.authorization) return res.json({ success: true, config: {}, authenticated: false })
    clientAuth(req, res, next)
}, (req, res) => {
    const publicKeys = [
        'aliyun_bailian_api_key',
        'aliyun_bailian_base_url',
        'aliyun_oss_access_key_id',
        'aliyun_oss_access_key_secret',
        'aliyun_oss_bucket',
        'aliyun_oss_region',
        'volcengine_api_key',
        'volcengine_model',
        'runninghub_api_key',
        'runninghub_workflow_id_1',
        'runninghub_workflow_id_2',
        'runninghub_workflow_id_3',
        'runninghub_workflow_id_4',
        'runninghub_workflow_id_5',
        'runninghub_workflow_id_6',
        'runninghub_workflow_id_7',
        'runninghub_workflow_id_8',
        'runninghub_mode1_nodes',
        'runninghub_mode2_nodes',
        'runninghub_mode3_nodes',
        'runninghub_mode4_nodes',
        'runninghub_mode5_nodes',
        'runninghub_mode6_nodes',
        'runninghub_mode7_nodes',
        'runninghub_mode8_nodes',
        'runninghub_tts_workflow_id_t2',
        'runninghub_tts_nodes_t2',
        'runninghub_tts_workflow_id_t3',
        'runninghub_tts_nodes_t3',
        'runninghub_tts_workflow_id_t4',
        'runninghub_tts_nodes_t4',
        'runninghub_tts_workflow_id_t5',
        'runninghub_tts_nodes_t5',
        'runninghub_tts_workflow_id_t6',
        'runninghub_tts_nodes_t6',
        'update_url',
        'runninghub_call_record_url',
        'model_providers'
    ]

    const placeholders = publicKeys.map(() => '?').join(',')
    db.all(
        `SELECT config_key, config_value FROM system_config WHERE config_key IN (${placeholders})`,
        publicKeys,
        (err, rows) => {
            if (err) return res.json({ success: false, error: err.message })

            const config = {}
            rows.forEach(row => {
                config[row.config_key] = row.config_value
            })

            res.json({ success: true, config })
        }
    )
})

// ==================== 管理员：获取所有系统配置 ====================
app.get(`${API_PREFIX}/admin/system/config`, adminAuth, (req, res) => {
    db.all('SELECT * FROM system_config ORDER BY id', [], (err, rows) => {
        if (err) return res.json({ success: false, error: err.message })
        res.json({ success: true, configs: rows })
    })
})

// ==================== 临时：生成测试卡密 ====================
app.post(`${API_PREFIX}/generate-test-cdkey`, adminAuth, (req, res) => {
    const generateCode = () => {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
        const prefix = (sensitiveConfig.CDKEY_PREFIX || 'XX') + '-'
        let code = prefix
        for (let i = 0; i < 4; i++) {
            for (let j = 0; j < 4; j++) {
                code += chars.charAt(Math.floor(Math.random() * chars.length))
            }
            if (i < 3) code += '-'
        }
        return code
    }

    const code = generateCode()
    db.run(
        `INSERT INTO cdkeys (code, type, days, video_quota, max_devices, created_by, note) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [code, 'standard', 30, 100, 1, 0, '测试卡密'],
        (err) => {
            if (err) {
                return res.json({ success: false, message: '生成卡密失败: ' + err.message })
            }
            res.json({
                success: true,
                cdkey: code,
                message: '测试卡密生成成功' 
            })
        }
    )
})

// ==================== 管理员：批量更新系统配置 ====================
app.put(`${API_PREFIX}/admin/system/config`, adminAuth, (req, res) => {
    const { configs } = req.body

    if (!configs || typeof configs !== 'object') {
        return res.json({ success: false, message: '配置数据格式错误' })
    }

    const entries = Object.entries(configs)
    let updated = 0

    entries.forEach(([key, value]) => {
        db.run(
            'INSERT OR IGNORE INTO system_config (config_key, config_value) VALUES (?, ?)',
            [key, ''],
            () => {
                db.run(
                    'UPDATE system_config SET config_value = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE config_key = ?',
                    [String(value), req.adminUser.username, key],
                    (err) => {
                        if (!err) updated++
                    }
                )
            }
        )
    })

    logAction(req.adminUser.id, 'system_config_update', `更新了 ${entries.length} 项系统配置`)

    setTimeout(() => {
        res.json({ success: true, message: `已更新 ${entries.length} 项配置`, updated })
    }, 100)
})

// ==================== 管理员：切换用户云端数字人权限 ====================
app.put(`${API_PREFIX}/admin/user/cloud-digital-human`, adminAuth, (req, res) => {
    const { user_id, disabled } = req.body

    if (!user_id) {
        return res.json({ success: false, message: '用户ID不能为空' })
    }

    db.run(
        'UPDATE users SET cloud_digital_human_disabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [disabled ? 1 : 0, user_id],
        (err) => {
            if (err) return res.json({ success: false, error: err.message })
            logAction(user_id, 'cloud_digital_human_toggle', `云端数字人功能已${disabled ? '关闭' : '开启'}`)
            res.json({
                success: true,
                message: `云端数字人功能已${disabled ? '关闭' : '开启'}`,
                cloud_digital_human_disabled: disabled ? 1 : 0
            })
        }
    )
})

// Web 管理后台路由
app.get(`${ADMIN_PATH}`, (req, res) => {
    // Keep relative stylesheet/script URLs under the configured admin mount.
    res.redirect(`${ADMIN_PATH}/admin.html`)
})

// ==================== 管理员：模型推送配置管理 ====================
// 获取模型推送配置
app.get(`${API_PREFIX}/admin/model-providers`, adminAuth, (req, res) => {
    db.get('SELECT config_value FROM system_config WHERE config_key = ?', ['model_providers'], (err, row) => {
        if (err) return res.json({ success: false, error: err.message })
        let providers = []
        try { providers = JSON.parse(row?.config_value || '[]') } catch { providers = [] }
        res.json({ success: true, providers })
    })
})

// 保存模型推送配置（整体替换）
app.put(`${API_PREFIX}/admin/model-providers`, adminAuth, (req, res) => {
    const { providers } = req.body
    if (!Array.isArray(providers)) {
        return res.json({ success: false, message: '数据格式错误，需要数组' })
    }
    const value = JSON.stringify(providers)
    db.run(
        'UPDATE system_config SET config_value = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE config_key = ?',
        [value, req.adminUser.username, 'model_providers'],
        (err) => {
            if (err) return res.json({ success: false, error: err.message })
            logAction(req.adminUser.id, 'model_providers_update', `更新了模型推送配置，共${providers.length}个供应商`)
            res.json({ success: true, message: '模型推送配置已保存' })
        }
    )
})

// ==================== 卡密管理：生成单个卡密 ====================
app.post(`${API_PREFIX}/admin/cdkey/create`, adminAuth, (req, res) => {
    const { type, days, video_quota, max_devices, note } = req.body

    // 根据卡密类型设置默认值
    let defaultDays = days
    let defaultQuota = video_quota
    if (type === 'trial') {
        defaultDays = defaultDays || 1
        defaultQuota = defaultQuota || 50
    } else if (type === 'annual') {
        defaultDays = defaultDays || 365
        defaultQuota = defaultQuota || 500
    } else {
        defaultDays = defaultDays || 365
        defaultQuota = defaultQuota || 500
    }

    const generateCode = () => {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
        const prefix = (sensitiveConfig.CDKEY_PREFIX || 'XX') + '-'
        let code = prefix
        for (let i = 0; i < 4; i++) {
            for (let j = 0; j < 4; j++) {
                code += chars.charAt(Math.floor(Math.random() * chars.length))
            }
            if (i < 3) code += '-'
        }
        return code
    }

    const code = generateCode()

    db.run(
        `INSERT INTO cdkeys (code, type, days, video_quota, max_devices, created_by, note) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [code, type || 'annual', defaultDays, defaultQuota, max_devices || 1, req.adminUser.id, note || ''],
        function (err) {
            if (err) {
                return res.json({ success: false, message: '创建失败: ' + err.message })
            }
            logAction(req.adminUser.id, 'cdkey_create', `创建卡密: ${code}`)
            res.json({
                success: true,
                cdkey: {
                    id: this.lastID,
                    code,
                    type: type || 'annual',
                    days: defaultDays,
                    video_quota: defaultQuota,
                    max_devices: max_devices || 1,
                    status: 'unused'
                }
            })
        }
    )
})

// ==================== 卡密管理：批量生成卡密 ====================
app.post(`${API_PREFIX}/admin/cdkey/batch-create`, adminAuth, (req, res) => {
    const { count, type, days, video_quota, max_devices, note } = req.body
    const batchCount = Math.min(parseInt(count) || 10, 100)

    // 根据卡密类型设置默认值
    let defaultDays = days
    let defaultQuota = video_quota
    if (type === 'trial') {
        defaultDays = defaultDays || 1
        defaultQuota = defaultQuota || 50
    } else if (type === 'annual') {
        defaultDays = defaultDays || 365
        defaultQuota = defaultQuota || 500
    } else {
        defaultDays = defaultDays || 365
        defaultQuota = defaultQuota || 500
    }

    const generateCode = () => {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
        const prefix = (sensitiveConfig.CDKEY_PREFIX || 'XX') + '-'
        let code = prefix
        for (let i = 0; i < 4; i++) {
            for (let j = 0; j < 4; j++) {
                code += chars.charAt(Math.floor(Math.random() * chars.length))
            }
            if (i < 3) code += '-'
        }
        return code
    }

    const generatedCodes = []
    let successCount = 0

    const insertCode = (callback) => {
        if (successCount >= batchCount) {
            return callback()
        }

        const code = generateCode()
        db.run(
            `INSERT INTO cdkeys (code, type, days, video_quota, max_devices, created_by, note) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [code, type || 'annual', defaultDays, defaultQuota, max_devices || 1, req.adminUser.id, note || ''],
            (err) => {
                if (!err) {
                    generatedCodes.push({
                        code,
                        type: type || 'annual',
                        days: defaultDays,
                        video_quota: defaultQuota,
                        max_devices: max_devices || 1
                    })
                    successCount++
                }
                insertCode(callback)
            }
        )
    }

    insertCode(() => {
        logAction(req.adminUser.id, 'cdkey_batch_create', `批量创建 ${successCount} 张卡密`)
        res.json({
            success: successCount > 0 || batchCount === 0,
            count: successCount,
            cdkeys: generatedCodes,
            message: successCount === 0 && batchCount > 0 ? '所有卡密生成失败，请重试' : undefined
        })
    })
})

// ==================== 卡密管理：查询卡密列表 ====================
app.get(`${API_PREFIX}/admin/cdkeys`, adminAuth, (req, res) => {
    const status = req.query.status || ''
    const page = parseInt(req.query.page) || 1
    const limit = parseInt(req.query.limit) || 50
    const offset = (page - 1) * limit

    let whereClause = ''
    let params = []

    if (status && ['unused', 'used'].includes(status)) {
        whereClause = 'WHERE c.status = ?'
        params.push(status)
    }

    db.all(
        `SELECT c.*, u.username as used_by_username 
         FROM cdkeys c 
         LEFT JOIN users u ON c.used_by = u.id 
         ${whereClause}
         ORDER BY c.created_at DESC 
         LIMIT ? OFFSET ?`,
        [...params, limit, offset],
        (err, cdkeys) => {
            if (err) return res.json({ success: false, error: err.message })

            db.get(`SELECT COUNT(*) as total FROM cdkeys ${whereClause}`, params, (err, countResult) => {
                res.json({
                    success: true,
                    cdkeys,
                    pagination: {
                        page,
                        limit,
                        total: countResult?.total || 0
                    }
                })
            })
        }
    )
})

// ==================== 卡密管理：删除卡密 ====================
app.delete(`${API_PREFIX}/admin/cdkey/:id`, adminAuth, (req, res) => {
    const cdkeyId = req.params.id

    db.get('SELECT * FROM cdkeys WHERE id = ?', [cdkeyId], (err, cdkey) => {
        if (!cdkey) {
            return res.json({ success: false, message: '卡密不存在' })
        }
        if (cdkey.status === 'used') {
            return res.json({ success: false, message: '已使用的卡密不能删除' })
        }

        db.run('DELETE FROM cdkeys WHERE id = ?', [cdkeyId], (err) => {
            if (err) return res.json({ success: false, error: err.message })
            logAction(req.adminUser.id, 'cdkey_delete', `删除卡密: ${cdkey.code}`)
            res.json({ success: true, message: '卡密已删除' })
        })
    })
})

// ==================== 卡密管理：导出卡密 ====================
app.get(`${API_PREFIX}/admin/cdkeys/export`, adminAuth, (req, res) => {
    const status = req.query.status || ''

    let whereClause = ''
    let params = []

    if (status && ['unused', 'used'].includes(status)) {
        whereClause = 'WHERE c.status = ?'
        params.push(status)
    }

    db.all(
        `SELECT c.code, c.type, c.days, c.video_quota, c.status, c.note, 
                c.created_at, c.used_at, u.username as used_by_username
         FROM cdkeys c 
         LEFT JOIN users u ON c.used_by = u.id 
         ${whereClause}
         ORDER BY c.created_at DESC`,
        params,
        (err, cdkeys) => {
            if (err) return res.json({ success: false, error: err.message })

            const csv = [
                ['卡密', '类型', '天数', '视频配额', '状态', '备注', '创建时间', '使用时间', '使用者'].join(','),
                ...cdkeys.map(c => [
                    c.code,
                    c.type,
                    c.days,
                    c.video_quota,
                    c.status === 'used' ? '已使用' : '未使用',
                    c.note || '',
                    c.created_at,
                    c.used_at || '',
                    c.used_by_username || ''
                ].join(','))
            ].join('\n')

            res.setHeader('Content-Type', 'text/csv; charset=utf-8')
            res.setHeader('Content-Disposition', 'attachment; filename=cdkeys.csv')
            res.send('\ufeff' + csv)
        }
    )
})

// ==================== 卡密管理：统计 ====================
app.get(`${API_PREFIX}/admin/cdkeys/stats`, adminAuth, (req, res) => {
    db.get(`
        SELECT 
            COUNT(*) as total,
            SUM(CASE WHEN status = 'unused' THEN 1 ELSE 0 END) as unused,
            SUM(CASE WHEN status = 'used' THEN 1 ELSE 0 END) as used,
            SUM(CASE WHEN status = 'used' AND DATE(used_at) = DATE('now', 'localtime') THEN 1 ELSE 0 END) as today_activated
        FROM cdkeys
    `, [], (err, stats) => {
        if (err) return res.json({ success: false, error: err.message })
        res.json({ success: true, stats })
    })
})

// ==================== 用户：验证卡密 ====================
app.post(`${API_PREFIX}/cdkey/verify`, (req, res) => {
    const { code } = req.body

    if (!code) {
        return res.json({ success: false, message: '请输入卡密' })
    }

    db.get('SELECT * FROM cdkeys WHERE code = ?', [code], (err, cdkey) => {
        if (!cdkey) {
            return res.json({ success: false, message: '卡密不存在' })
        }
        if (cdkey.status === 'used') {
            return res.json({ success: false, message: '卡密已被使用' })
        }

        res.json({
            success: true,
            cdkey: {
                type: cdkey.type,
                days: cdkey.days,
                video_quota: cdkey.video_quota
            }
        })
    })
})

// ==================== 用户：消耗配额（语音生成/数字人/克隆音色） ====================
app.post(`${API_PREFIX}/quota/use`, clientAuth, accountScope, (req, res) => {
    const { user_id, type } = req.body
    // type: 'tts'(文字生成语音) / 'digital_human'(数字人对口型) / 'voice_clone'(克隆音色)
    const validTypes = ['tts', 'digital_human', 'voice_clone']
    const typeLabels = { tts: '文字生成语音', digital_human: '数字人对口型', voice_clone: '克隆音色' }

    if (!user_id) {
        return res.json({ success: false, message: '用户ID不能为空' })
    }
    if (!type || !validTypes.includes(type)) {
        return res.json({ success: false, message: '无效的消耗类型' })
    }

    db.get('SELECT video_quota, video_used FROM users WHERE id = ?', [user_id], (err, user) => {
        if (!user) {
            return res.json({ success: false, message: '用户不存在' })
        }

        if (user.video_quota <= user.video_used) {
            return res.json({ success: false, message: '配额已用完' })
        }

        db.run('UPDATE users SET video_used = video_used + 1 WHERE id = ?', [user_id], (err) => {
            if (err) return res.json({ success: false, message: '更新失败' })

            // 记录消耗日志
            db.run(
                'INSERT INTO generation_logs (user_id, type, detail) VALUES (?, ?, ?)',
                [user_id, 'quota_use', `${typeLabels[type]} 消耗1次配额`]
            )

            res.json({
                success: true,
                type,
                type_label: typeLabels[type],
                video_quota: user.video_quota,
                video_used: user.video_used + 1,
                video_remaining: user.video_quota - user.video_used - 1
            })
        })
    })
})

// ==================== 用户：查询配额（语音/数字人/克隆音色共用） ====================
app.get(`${API_PREFIX}/video/quota/:userId`, clientAuth, accountScope, (req, res) => {
    const userId = req.params.userId

    db.get('SELECT video_quota, video_used FROM users WHERE id = ?', [userId], (err, user) => {
        if (!user) {
            return res.json({ success: false, message: '用户不存在' })
        }

        res.json({
            success: true,
            video_quota: user.video_quota,
            video_used: user.video_used,
            video_remaining: user.video_quota - user.video_used
        })
    })
})

// Queue behind schema migrations, and seed before accepting login requests.
db.get('SELECT 1', async (schemaError) => {
 try {
  if(schemaError) throw schemaError;
  const created=await require('./bootstrap-admin').bootstrapAdmin(db, HOST);
  if(created) console.log('Created local default administrator. Change its password before network deployment.');
  app.listen(PORT, HOST, () => {
    console.log(`\n✅ 用户管理服务器已启动`)
    console.log(`📋 管理后台: http://localhost:${PORT}${ADMIN_PATH}`)
    console.log(`📡 API 地址: http://localhost:${PORT}${API_PREFIX}\n`)
})
 } catch(error) { console.error('Backend initialization failed:',error.message);db.close();process.exitCode=1; }
});
