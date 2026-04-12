const { Pool } = require('pg');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();

// Required behind Render/Reverse proxies so req.protocol reflects x-forwarded-proto.
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads'));

// DB CONNECTION
const pool = new Pool({
    connectionString:
        process.env.DATABASE_URL ||
        'postgresql://neondb_owner:npg_iAao5cOLrbY9@ep-muddy-recipe-a1d53akz-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require',
    ssl: { rejectUnauthorized: false },
});

const PORT = process.env.PORT || 3000;

// FILE STORAGE
const uploadsDir = process.env.UPLOADS_DIR
    ? path.resolve(process.env.UPLOADS_DIR)
    : path.join(__dirname, 'uploads');
const legacyUploadsDirs = [
    path.join(__dirname, 'uploads'),
    path.join(process.cwd(), 'uploads'),
].filter((value, index, arr) => arr.indexOf(value) === index);

if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Serve files from both current and legacy upload locations.
app.use('/uploads', express.static(uploadsDir));
legacyUploadsDirs.forEach((legacyDir) => {
    if (legacyDir !== uploadsDir) {
        app.use('/uploads', express.static(legacyDir));
    }
});

function normalizeStoredFilePath(filePath) {
    const normalized = String(filePath || '')
        .replace(/\\/g, '/')
        .replace(/^\/+/, '');

    if (normalized.startsWith('uploads/')) {
        return normalized.slice('uploads/'.length);
    }

    if (normalized.startsWith('Backend/uploads/')) {
        return normalized.slice('Backend/uploads/'.length);
    }

    return normalized;
}

function getDocumentFileCandidates(filePath) {
    const normalizedOriginal = String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const normalized = normalizeStoredFilePath(normalizedOriginal);
    const uniqueRelativeCandidates = [
        normalized,
        normalizedOriginal,
        `uploads/${normalized}`,
        `Backend/uploads/${normalized}`,
    ].filter((value, index, arr) => value && arr.indexOf(value) === index);

    const absoluteCandidates = [];
    [uploadsDir, ...legacyUploadsDirs].forEach((rootDir) => {
        uniqueRelativeCandidates.forEach((relativePath) => {
            absoluteCandidates.push(path.join(rootDir, relativePath));
        });
    });

    return absoluteCandidates.filter((value, index, arr) => arr.indexOf(value) === index);
}

function findExistingDocumentFile(filePath) {
    const candidates = getDocumentFileCandidates(filePath);
    return candidates.find((candidate) => fs.existsSync(candidate));
}

function tryDeleteDocumentFile(filePath) {
    const resolvedFile = findExistingDocumentFile(filePath);

    if (!resolvedFile) {
        return { deleted: false, reason: 'missing' };
    }

    try {
        fs.unlinkSync(resolvedFile);
        return { deleted: true, path: resolvedFile };
    } catch (error) {
        return { deleted: false, reason: 'unlink_failed', error: error.message };
    }
}

function removeDirIfEmpty(dirPath) {
    if (!dirPath || !fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
        return false;
    }

    const remainingItems = fs.readdirSync(dirPath);
    if (remainingItems.length > 0) {
        return false;
    }

    fs.rmdirSync(dirPath);
    return true;
}

function cleanupApplicationUploadDirs(applicationId) {
    const folderName = `application-${applicationId}`;
    const candidates = [
        path.join(uploadsDir, folderName),
        ...legacyUploadsDirs.map((legacyDir) => path.join(legacyDir, folderName)),
    ].filter((value, index, arr) => arr.indexOf(value) === index);

    let removedCount = 0;
    candidates.forEach((candidate) => {
        try {
            if (removeDirIfEmpty(candidate)) {
                removedCount += 1;
            }
        } catch (error) {
            // Ignore cleanup errors because the main delete action already succeeded.
        }
    });

    return removedCount;
}

function sanitizeFileName(fileName) {
    return fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function ensureApplicationDir(applicationId) {
    const applicationDir = path.join(uploadsDir, `application-${applicationId}`);

    if (!fs.existsSync(applicationDir)) {
        fs.mkdirSync(applicationDir, { recursive: true });
    }

    return applicationDir;
}

function getPublicBaseUrl(req) {
    if (process.env.PUBLIC_BASE_URL) {
        return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
    }

    const forwardedProto = String(req.get('x-forwarded-proto') || req.protocol || 'https')
        .split(',')[0]
        .trim()
        .toLowerCase();
    const protocol = forwardedProto || 'https';
    const host = req.get('x-forwarded-host') || req.get('host');

    return `${protocol}://${host}`;
}

async function ensureSchema() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS admin_users (
            id SERIAL PRIMARY KEY,
            username VARCHAR(100) UNIQUE NOT NULL,
            password VARCHAR(255) NOT NULL,
            display_name VARCHAR(150) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS employee_id VARCHAR(50)`);
    await pool.query(`ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS full_name VARCHAR(200)`);
    await pool.query(`ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT 'officer'`);
    await pool.query(`ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE`);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            email VARCHAR(255) UNIQUE,
            phone VARCHAR(20) UNIQUE,
            password VARCHAR(255),
            first_name VARCHAR(100),
            last_name VARCHAR(100),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS applications (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id),
            reference_no VARCHAR(50),
            status VARCHAR(50) DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS documents (
            id SERIAL PRIMARY KEY,
            user_id INTEGER,
            application_id INTEGER REFERENCES applications(id),
            document_type VARCHAR(150),
            file_name VARCHAR(255),
            file_path VARCHAR(255),
            review_status VARCHAR(50) DEFAULT 'pending',
            uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS application_status_history (
            id SERIAL PRIMARY KEY,
            application_id INTEGER REFERENCES applications(id) ON DELETE CASCADE,
            status_code VARCHAR(50) NOT NULL,
            status_label VARCHAR(100) NOT NULL,
            notes TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
}

const APPLICATION_STEPS = [
    { code: 'submitted', label: 'Submitted', description: 'Application submitted by applicant.' },
    { code: 'under_review', label: 'Under Review', description: 'Planning officers are checking documents and zoning rules.' },
    { code: 'committee', label: 'Committee', description: 'Application placed before Planning Committee.' },
    { code: 'approved', label: 'Approved', description: 'Development permit issued.' },
];

function getStepIndex(statusCode) {
    const index = APPLICATION_STEPS.findIndex((step) => step.code === statusCode);
    return index === -1 ? 0 : index;
}

function normalizeStatus(statusCode) {
    const matchedStep = APPLICATION_STEPS.find((step) => step.code === statusCode);
    return matchedStep || APPLICATION_STEPS[0];
}

async function addStatusHistory(applicationId, statusCode, notes) {
    const status = normalizeStatus(statusCode);

    await pool.query(
        `INSERT INTO application_status_history (application_id, status_code, status_label, notes)
         VALUES ($1, $2, $3, $4)`,
        [applicationId, status.code, status.label, notes || null]
    );
}

async function getStatusHistory(applicationId) {
    const result = await pool.query(
        `SELECT status_code, status_label, notes, created_at
         FROM application_status_history
         WHERE application_id = $1
         ORDER BY created_at ASC, id ASC`,
        [applicationId]
    );

    return result.rows;
}

async function ensureDefaultAdmin() {
    const adminResult = await pool.query(
        'SELECT id FROM admin_users WHERE username = $1',
        ['admin']
    );

    if (adminResult.rows.length > 0) {
        // Ensure the seeded account always has super_admin role
        await pool.query(
            "UPDATE admin_users SET role = 'super_admin', is_active = TRUE WHERE username = 'admin'"
        );
        return;
    }

    const passwordHash = await bcrypt.hash('Admin@1234', 10);

    await pool.query(
        'INSERT INTO admin_users (username, password, display_name, full_name, employee_id, role, is_active) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        ['admin', passwordHash, 'System Admin', 'System Administrator', 'EMP-0001', 'super_admin', true]
    );
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const { application_id: applicationId } = req.body;

        if (!applicationId) {
            cb(new Error('Missing application_id'));
            return;
        }

        cb(null, ensureApplicationDir(applicationId));
    },
    filename: (req, file, cb) =>
        cb(null, Date.now() + '-' + sanitizeFileName(file.originalname)),
});

const upload = multer({ storage });

// ROOT
app.get('/', (req, res) => {
    res.send('Backend running');
});


// =========================
// ADMIN LOGIN
// =========================
app.post('/admin/login', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }

    try {
        const result = await pool.query(
            'SELECT id, username, password, display_name, full_name, employee_id, role, is_active FROM admin_users WHERE username = $1',
            [username]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const admin = result.rows[0];

        if (!admin.is_active) {
            return res.status(403).json({ error: 'This account has been deactivated. Contact the system administrator.' });
        }

        const matches = await bcrypt.compare(password, admin.password);

        if (!matches) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        res.json({
            message: 'Admin login successful',
            admin: {
                id: admin.id,
                username: admin.username,
                display_name: admin.display_name,
                full_name: admin.full_name,
                employee_id: admin.employee_id,
                role: admin.role
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Unable to login as admin' });
    }
});


// =========================
// EMPLOYEE MANAGEMENT
// =========================
async function requireSuperAdmin(requestedById) {
    const result = await pool.query(
        "SELECT role, is_active FROM admin_users WHERE id = $1",
        [requestedById]
    );
    if (result.rows.length === 0) return false;
    const { role, is_active } = result.rows[0];
    return is_active && role === 'super_admin';
}

app.get('/admin/employees', async (req, res) => {
    const requestedById = parseInt(req.query.requestedById, 10);
    if (!requestedById) return res.status(400).json({ error: 'requestedById is required' });

    // Any active admin can list employees
    const check = await pool.query(
        'SELECT id FROM admin_users WHERE id = $1 AND is_active = TRUE',
        [requestedById]
    );
    if (check.rows.length === 0) return res.status(403).json({ error: 'Unauthorized' });

    try {
        const result = await pool.query(
            'SELECT id, employee_id, username, display_name, full_name, role, is_active, created_at FROM admin_users ORDER BY created_at ASC'
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Unable to fetch employees' });
    }
});

app.post('/admin/employees', async (req, res) => {
    const { requestedById, employee_id, full_name, username, password, role } = req.body;

    if (!requestedById) return res.status(400).json({ error: 'requestedById is required' });
    if (!full_name || !username || !password) {
        return res.status(400).json({ error: 'full_name, username, and password are required' });
    }

    const allowedRoles = ['officer', 'super_admin'];
    const assignedRole = allowedRoles.includes(role) ? role : 'officer';

    try {
        const isSuperAdmin = await requireSuperAdmin(requestedById);
        if (!isSuperAdmin) return res.status(403).json({ error: 'Only a super admin can add employees' });

        const existing = await pool.query('SELECT id FROM admin_users WHERE username = $1', [username]);
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: 'Username already exists' });
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const result = await pool.query(
            'INSERT INTO admin_users (employee_id, full_name, username, password, display_name, role, is_active) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, employee_id, username, full_name, role',
            [employee_id || null, full_name, username, passwordHash, full_name, assignedRole, true]
        );

        res.status(201).json({ message: 'Employee added', employee: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Unable to add employee' });
    }
});

app.patch('/admin/employees/:id', async (req, res) => {
    const empId = parseInt(req.params.id, 10);
    const { requestedById, is_active } = req.body;

    if (!requestedById) return res.status(400).json({ error: 'requestedById is required' });
    if (typeof is_active !== 'boolean') return res.status(400).json({ error: 'is_active (boolean) is required' });

    try {
        const isSuperAdmin = await requireSuperAdmin(requestedById);
        if (!isSuperAdmin) return res.status(403).json({ error: 'Only a super admin can change employee status' });

        // Prevent deactivating self
        if (parseInt(requestedById, 10) === empId && !is_active) {
            return res.status(400).json({ error: 'You cannot deactivate your own account' });
        }

        const result = await pool.query(
            'UPDATE admin_users SET is_active = $1 WHERE id = $2 RETURNING id, username, is_active',
            [is_active, empId]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Employee not found' });

        res.json({ message: 'Employee status updated', employee: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Unable to update employee status' });
    }
});


// =========================
// REGISTER
// =========================
app.post('/register', async (req, res) => {
    const { email, phone, password, firstName, lastName } = req.body;

    try {
        const hash = await bcrypt.hash(password, 10);

        await pool.query(
            'INSERT INTO users (email, phone, password, first_name, last_name) VALUES ($1,$2,$3,$4,$5)',
            [email, phone, hash, firstName, lastName]
        );

        res.json({ message: 'User registered', phone });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error');
    }
});


// =========================
// LOGIN
// =========================
app.post('/login', async (req, res) => {
    const { phone, password } = req.body;

    try {
        const result = await pool.query(
            'SELECT * FROM users WHERE phone=$1',
            [phone]
        );

        if (result.rows.length === 0)
            return res.status(401).json({ error: 'User not found' });

        const user = result.rows[0];
        const match = await bcrypt.compare(password, user.password);

        if (!match)
            return res.status(401).json({ error: 'Wrong password' });

        res.json({
            message: 'Login successful',
            user: {
                id: user.id,
                phone: user.phone
            }
        });

    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});


// =========================
// CREATE APPLICATION
// =========================
function generateID(id) {
    const year = new Date().getFullYear();
    return `KMC-PLN-${year}-${String(id).padStart(3, '0')}`;
}

app.post('/create-application', async (req, res) => {
    const { user_id } = req.body;

    try {
        const userResult = await pool.query(
            'SELECT id FROM users WHERE id=$1',
            [user_id]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const result = await pool.query(
            'INSERT INTO applications (user_id) VALUES ($1) RETURNING id',
            [user_id]
        );

        const id = result.rows[0].id;
        const ref = generateID(id);

        await pool.query(
            'UPDATE applications SET reference_no=$1 WHERE id=$2',
            [ref, id]
        );

        await addStatusHistory(id, 'submitted', 'Application created and awaiting review.');

        res.json({
            application_id: id,
            trackingID: ref,
            reference_no: ref
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Unable to create application' });
    }
});


// =========================
// UPLOAD
// =========================
app.post('/upload', upload.single('document'), async (req, res) => {
    try {
        const file = req.file;
        const { user_id, application_id, document_type } = req.body;

        if (!file) return res.status(400).send('No file');

        const applicationResult = await pool.query(
            'SELECT id FROM applications WHERE id=$1 AND user_id=$2',
            [application_id, user_id]
        );

        if (applicationResult.rows.length === 0) {
            return res.status(404).json({ error: 'Application not found for this user' });
        }

        const relativePath = path.relative(uploadsDir, file.path).split(path.sep).join('/');

        await pool.query(
            'INSERT INTO documents (user_id, application_id, document_type, file_name, file_path) VALUES ($1,$2,$3,$4,$5)',
            [user_id, application_id, document_type || 'Uncategorized', file.originalname, relativePath]
        );

        res.json({
            message: 'Uploaded',
            document: {
                document_type: document_type || 'Uncategorized',
                file_name: file.originalname,
                file_path: relativePath,
                download_url: `${getPublicBaseUrl(req)}/uploads/${relativePath}`
            }
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Upload error' });
    }
});


// =========================
// ADMIN APPLICATIONS
// =========================
app.get('/admin/applications', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                a.id,
                a.reference_no,
                a.status,
                a.created_at,
                u.phone,
                COUNT(d.id) AS document_count
            FROM applications a
            LEFT JOIN users u ON u.id = a.user_id
            LEFT JOIN documents d ON d.application_id = a.id
            GROUP BY a.id, u.phone
            ORDER BY a.created_at DESC, a.id DESC
        `);

        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Unable to load applications' });
    }
});

app.get('/admin/applications/:reference/documents', async (req, res) => {
    const { reference } = req.params;

    try {
        const applicationResult = await pool.query(`
            SELECT
                a.id,
                a.reference_no,
                a.status,
                a.created_at,
                u.phone
            FROM applications a
            LEFT JOIN users u ON u.id = a.user_id
            WHERE a.reference_no = $1
        `, [reference]);

        if (applicationResult.rows.length === 0) {
            return res.status(404).json({ error: 'Application not found' });
        }

        const application = applicationResult.rows[0];
        const documentResult = await pool.query(`
            SELECT
                id,
                document_type,
                file_name,
                file_path,
                review_status,
                uploaded_at
            FROM documents
            WHERE application_id = $1
            ORDER BY uploaded_at ASC, id ASC
        `, [application.id]);

        const statusHistory = await getStatusHistory(application.id);
        const documents = documentResult.rows.map((document) => ({
            ...document,
            download_url: `${getPublicBaseUrl(req)}/admin/documents/${document.id}/download`
        }));

        res.json({ application, documents, statusHistory });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Unable to load application documents' });
    }
});

app.post('/admin/applications/:reference/status', async (req, res) => {
    const { reference } = req.params;
    const { status, notes } = req.body;
    const normalizedStatus = normalizeStatus(status);

    try {
        const applicationResult = await pool.query(
            'SELECT id FROM applications WHERE reference_no = $1',
            [reference]
        );

        if (applicationResult.rows.length === 0) {
            return res.status(404).json({ error: 'Application not found' });
        }

        const applicationId = applicationResult.rows[0].id;

        await pool.query(
            'UPDATE applications SET status = $1 WHERE id = $2',
            [normalizedStatus.code, applicationId]
        );

        await addStatusHistory(applicationId, normalizedStatus.code, notes || `Status changed to ${normalizedStatus.label}.`);

        res.json({ message: 'Status updated', status: normalizedStatus.code });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Unable to update application status' });
    }
});


// =========================
// DOCUMENT REVIEW STATUS
// =========================
app.patch('/admin/documents/:id/review', async (req, res) => {
    const docId = parseInt(req.params.id, 10);
    const { review_status } = req.body;
    const allowed = ['pending', 'approved', 'rejected'];
    if (!allowed.includes(review_status)) {
        return res.status(400).json({ error: 'Invalid review_status value' });
    }
    try {
        const result = await pool.query(
            'UPDATE documents SET review_status = $1 WHERE id = $2 RETURNING id',
            [review_status, docId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Document not found' });
        }
        res.json({ message: 'Document status updated', id: docId, review_status });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Unable to update document status' });
    }
});

app.delete('/admin/documents/:id', async (req, res) => {
    const docId = parseInt(req.params.id, 10);

    if (Number.isNaN(docId)) {
        return res.status(400).json({ error: 'Invalid document id' });
    }

    try {
        const result = await pool.query(
            'SELECT id, application_id, file_name, file_path FROM documents WHERE id = $1',
            [docId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Document not found' });
        }

        const document = result.rows[0];
        const fileDeleteResult = tryDeleteDocumentFile(document.file_path);

        await pool.query('DELETE FROM documents WHERE id = $1', [docId]);
        const cleaned_folders = cleanupApplicationUploadDirs(document.application_id);

        return res.json({
            message: 'Document deleted',
            id: docId,
            application_id: document.application_id,
            file_deleted: fileDeleteResult.deleted,
            file_delete_reason: fileDeleteResult.reason || null,
            cleaned_folders,
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Unable to delete document' });
    }
});

app.delete('/admin/applications/:reference/documents', async (req, res) => {
    const { reference } = req.params;

    try {
        const appResult = await pool.query(
            'SELECT id FROM applications WHERE reference_no = $1',
            [reference]
        );

        if (appResult.rows.length === 0) {
            return res.status(404).json({ error: 'Application not found' });
        }

        const applicationId = appResult.rows[0].id;
        const docsResult = await pool.query(
            'SELECT id, file_path FROM documents WHERE application_id = $1',
            [applicationId]
        );

        let deletedFiles = 0;
        let missingFiles = 0;

        docsResult.rows.forEach((document) => {
            const fileDeleteResult = tryDeleteDocumentFile(document.file_path);
            if (fileDeleteResult.deleted) {
                deletedFiles += 1;
            } else if (fileDeleteResult.reason === 'missing') {
                missingFiles += 1;
            }
        });

        const deleteResult = await pool.query(
            'DELETE FROM documents WHERE application_id = $1 RETURNING id',
            [applicationId]
        );
        const cleaned_folders = cleanupApplicationUploadDirs(applicationId);

        return res.json({
            message: 'Application documents deleted',
            reference,
            application_id: applicationId,
            deleted_documents: deleteResult.rowCount,
            deleted_files: deletedFiles,
            missing_files: missingFiles,
            cleaned_folders,
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Unable to delete application documents' });
    }
});

app.get(/^\/uploads\/(.+)$/, (req, res) => {
    const requestedRelativePath = String(req.params[0] || '').replace(/\\/g, '/').replace(/^\/+/, '');

    if (!requestedRelativePath) {
        return res.status(400).json({ error: 'Invalid upload path' });
    }

    const resolvedFile = findExistingDocumentFile(requestedRelativePath);

    if (!resolvedFile) {
        return res.status(404).json({
            error: 'File not found on server storage',
            requested_path: requestedRelativePath,
        });
    }

    return res.sendFile(resolvedFile);
});

app.get('/admin/documents/:id/download', async (req, res) => {
    const docId = parseInt(req.params.id, 10);

    if (Number.isNaN(docId)) {
        return res.status(400).json({ error: 'Invalid document id' });
    }

    try {
        const result = await pool.query(
            'SELECT id, file_name, file_path FROM documents WHERE id = $1',
            [docId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Document not found' });
        }

        const document = result.rows[0];
        const resolvedFile = findExistingDocumentFile(document.file_path);

        if (!resolvedFile) {
            return res.status(404).json({
                error: 'File not found on server storage',
                document_id: document.id,
                file_path: document.file_path,
            });
        }

        return res.download(resolvedFile, document.file_name || path.basename(resolvedFile));
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Unable to download document' });
    }
});

// =========================
// TRACK
// =========================
app.get('/track/:ref', async (req, res) => {
    const ref = req.params.ref;

    try {
        const result = await pool.query(
            `SELECT a.*, u.phone
             FROM applications a
             LEFT JOIN users u ON u.id = a.user_id
             WHERE a.reference_no=$1`,
            [ref]
        );

        if (result.rows.length === 0)
            return res.status(404).json({ error: 'Application not found' });

        const application = result.rows[0];
        const docReviewResult = await pool.query(
            `SELECT
                COUNT(*)::int AS total_documents,
                COUNT(*) FILTER (WHERE review_status = 'rejected')::int AS rejected_documents,
                COUNT(*) FILTER (WHERE review_status = 'approved')::int AS approved_documents,
                COUNT(*) FILTER (WHERE review_status = 'pending' OR review_status IS NULL)::int AS pending_documents
             FROM documents
             WHERE application_id = $1`,
            [application.id]
        );
        const docReviewSummary = docReviewResult.rows[0] || {
            total_documents: 0,
            rejected_documents: 0,
            approved_documents: 0,
            pending_documents: 0,
        };
        const history = await getStatusHistory(application.id);
        const currentIndex = getStepIndex(application.status || 'submitted');
        const steps = APPLICATION_STEPS.map((step, index) => ({
            ...step,
            active: index <= currentIndex,
            current: index === currentIndex,
        }));

        res.json({ application, history, steps, docReviewSummary });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});


// START
async function startServer() {
    try {
        await ensureSchema();
        await ensureDefaultAdmin();
        await pool.query('SELECT NOW()');
        console.log('DB connected');
        console.log('Uploads directory:', uploadsDir);

        app.listen(PORT, () => {
            console.log('Server running on ' + PORT);
        });
    } catch (err) {
        console.error('Startup failed', err);
        process.exit(1);
    }
}

startServer();