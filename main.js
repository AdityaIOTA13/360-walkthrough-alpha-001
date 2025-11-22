// Configuration - Multi-floor support with Cloudflare R2
const R2_BASE_URL = 'https://pub-a901561e98c4422f9a0df782ce967b67.r2.dev/Boomerang_Club_360';
const EXT = '.jpg';
const PRELOAD_AHEAD = 5;      // Number of images to preload ahead and behind

const FLOORS = {
    'ground': {
        name: 'Ground Floor',
        totalSteps: 36,
        imageDir: `${R2_BASE_URL}/ground-floor/`,
        svgPath: './data/paths/Ground.svg',
        bgImage: './data/floorplans/ground_floor_plan.png'
    },
    '3rd': {
        name: '3rd Floor',
        totalSteps: 18,
        imageDir: `${R2_BASE_URL}/floor-3/`,
        svgPath: './data/paths/Floor_3.svg',
        bgImage: './data/floorplans/floor_3_plan.png'
    },
    'roof': {
        name: 'Roof',
        totalSteps: 19,
        imageDir: `${R2_BASE_URL}/roof/`,
        svgPath: './data/paths/Roof.svg',
        bgImage: './data/floorplans/roof_plan.png'
    }
};

// Equirectangular image dimensions (standard 2:1 ratio)
const EQUIRECT_WIDTH = 4096;
const EQUIRECT_HEIGHT = 2048;

// Comments using equirectangular coordinates (x, y pixels from top-left)
const COMMENTS = {
    '3rd': {
        1: [
            {
                x: 200,
                y: 1300,
                title: "Debris Uncleared",
                description: "Construction debris has remained uncleared in this area for over 2 weeks. This poses a safety hazard and needs immediate attention.",
                risk: "normal"
            }
        ],
        13: [
            {
                x: 1950,
                y: 1255,
                title: "Fire Hazard (Poor wire management)",
                description: "Exposed electrical wiring and poor cable management poses a significant fire risk. Immediate rectification required.",
                risk: "high"
            }
        ]
    },
    'ground': {
        25: [
            {
                x: 1400,
                y: 720,
                title: "Exposed concrete formwork. Medium risk due to rain. Can be covered.",
                description: "The concrete formwork is currently exposed to weather elements. Cover with tarpaulin to prevent water damage.",
                risk: "medium"
            }
        ]
    },
    'roof': {
        6: [
            {
                x: 300,
                y: 1000,
                title: "HVAC Cooling Tower Installed",
                description: "New HVAC cooling tower has been successfully installed and is operational.",
                risk: "info"
            }
        ]
    }
};

// State
let currentFloor = '3rd';     // Default floor
let currentStep = 1;
let imageCache = new Map();
let isLoading = false;
let currentZoom = 100;
let isMinimapMinimized = false;
let resolvedCommentsCache = [];
let pendingLookAt = null;
let lastGestureScale = 1;
let gestureListenersBound = false;
let wheelDeltaBuffer = 0;
let activeCommentKey = null;
let activeCommentRef = null;
const commentThreads = {};
const userComments = {};
let isAddCommentMode = false;
let pendingAddPosition = null;

function getReplyPlainText() {
    if (!commentReplyInput) return '';
    return (commentReplyInput.textContent || '').trim();
}

function highlightMentions(text) {
    if (!text) return '';
    const escaped = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    const withMentions = escaped.replace(/(@[A-Za-z][\w]*)/g, (match) => {
        const isAI = /^@ai$/i.test(match);
        const classes = isAI ? 'comment-mention comment-mention-ai' : 'comment-mention';
        return `<span class="${classes}">${match}</span>`;
    });
    return withMentions.replace(/\n/g, '<br>');
}

function placeCaretAtEnd(el) {
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
}

function renderReplyInput() {
    if (!commentReplyInput) return;
    const plain = commentReplyInput.textContent || '';
    const highlighted = highlightMentions(plain);
    const currentHTML = commentReplyInput.innerHTML;
    if (currentHTML !== highlighted) {
        commentReplyInput.innerHTML = highlighted;
        placeCaretAtEnd(commentReplyInput);
    }
}

function intersectionToEquirect(detail) {
    if (!detail || !detail.intersection) return null;
    const { intersection } = detail;
    if (intersection.point) {
        // Use world-space point so it lines up with the same orientation used for existing pins
        return threeDToEquirect(intersection.point.x, intersection.point.y, intersection.point.z);
    }
    if (intersection.uv) {
        return {
            x: intersection.uv.x * EQUIRECT_WIDTH,
            y: intersection.uv.y * EQUIRECT_HEIGHT
        };
    }
    return null;
}

function setAddCommentMode(enabled) {
    isAddCommentMode = enabled;
    pendingAddPosition = null;
    document.body.classList.toggle('add-comment-active', enabled);
    if (addCommentBtn) {
        addCommentBtn.classList.toggle('active', enabled);
    }
    if (addCommentHint) {
        addCommentHint.classList.toggle('visible', enabled);
    }
    if (!enabled) {
        closeAddCommentComposer();
    }
}

function openAddCommentComposer() {
    if (!addCommentComposer) return;
    addCommentComposer.classList.add('active');
    if (addCommentInput) {
        addCommentInput.value = '';
        addCommentInput.focus();
    }
    if (addCommentRisk) {
        addCommentRisk.value = 'normal';
    }
    updateAddComposerState();
}

function closeAddCommentComposer() {
    if (addCommentComposer) {
        addCommentComposer.classList.remove('active');
    }
    if (addCommentInput) {
        addCommentInput.value = '';
    }
    if (addCommentRisk) {
        addCommentRisk.value = 'normal';
    }
    if (addCommentSave) {
        addCommentSave.disabled = true;
    }
}

function updateAddComposerState() {
    if (!addCommentSave || !addCommentInput) return;
    addCommentSave.disabled = addCommentInput.value.trim().length === 0 || !pendingAddPosition;
}

function handleSceneClickForCommentPlacement(e) {
    if (!isAddCommentMode) return;
    const coords = intersectionToEquirect(e.detail);
    if (!coords) {
        console.warn('Could not map click to equirectangular coordinates');
        return;
    }
    pendingAddPosition = coords;
    openAddCommentComposer();
    if (addCommentHint) addCommentHint.classList.remove('visible');
}

function savePendingComment() {
    if (!pendingAddPosition || !addCommentInput) return;
    const text = addCommentInput.value.trim();
    if (!text) {
        updateAddComposerState();
        return;
    }
    const riskValue = (addCommentRisk && addCommentRisk.value) || 'normal';
    const newComment = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        x: pendingAddPosition.x,
        y: pendingAddPosition.y,
        title: text,
        description: text,
        risk: riskValue,
        isUser: true,
        floor: currentFloor,
        step: currentStep
    };
    addUserComment(currentFloor, currentStep, newComment);
    createCommentPins();
    populateCommentsList();
    pendingAddPosition = null;
    closeAddCommentComposer();
    setAddCommentMode(false);
}

// Helper functions to get current floor config
function getCurrentFloorConfig() {
    return FLOORS[currentFloor];
}

function getTotalSteps() {
    return getCurrentFloorConfig().totalSteps;
}

// Get risk level for a specific step on a specific floor
function getRiskLevelForStep(floor, step) {
    const floorComments = COMMENTS[floor] || {};
    const stepComments = floorComments[step];
    if (stepComments && stepComments.length > 0) {
        // Return the risk level of the first comment
        return stepComments[0].risk;
    }
    return null;
}

// Orient the camera toward a comment's equirectangular coordinate (with optional yaw offset)
function lookAtCommentCoordinate(x, y, yawOffsetDeg = 0) {
    const cameraEl = document.querySelector('a-camera');
    if (!cameraEl || typeof THREE === 'undefined') return;
    
    const target = equirectTo3D(x, y, 8);
    const lookVec = new THREE.Vector3(target.x, target.y, target.z);
    
    cameraEl.object3D.lookAt(lookVec);
    
    if (yawOffsetDeg !== 0) {
        cameraEl.object3D.rotateY(THREE.MathUtils.degToRad(yawOffsetDeg));
    }
    
    cameraEl.object3D.updateMatrixWorld();
}

function applyPendingLookAt() {
    if (!pendingLookAt) return;
    const { x, y, yawOffset = 0 } = pendingLookAt;
    lookAtCommentCoordinate(x, y, yawOffset);
    pendingLookAt = null;
}

function getStepComments(floor, step) {
    const base = (COMMENTS[floor] && COMMENTS[floor][step]) ? COMMENTS[floor][step] : [];
    const custom = (userComments[floor] && userComments[floor][step]) ? userComments[floor][step] : [];
    return [...base, ...custom];
}

function getAllCommentsForFloor(floor) {
    const base = COMMENTS[floor] || {};
    const custom = userComments[floor] || {};
    const merged = {};
    const steps = new Set([...Object.keys(base), ...Object.keys(custom)]);
    steps.forEach(step => {
        merged[step] = [...(base[step] || []), ...(custom[step] || [])];
    });
    return merged;
}

function addUserComment(floor, step, comment) {
    if (!userComments[floor]) userComments[floor] = {};
    if (!userComments[floor][step]) userComments[floor][step] = [];
    userComments[floor][step].push(comment);
}

// Convert equirectangular coordinates to 3D spherical position
function equirectTo3D(x, y, radius = 8) {
    // Convert pixel coordinates to normalized (0-1)
    const u = x / EQUIRECT_WIDTH;
    const v = y / EQUIRECT_HEIGHT;
    
    // Convert to spherical coordinates
    const theta = (u - 0.5) * Math.PI * 2;  // Longitude: -PI to PI
    const phi = (v - 0.5) * Math.PI;        // Latitude: -PI/2 to PI/2
    
    // Convert spherical to Cartesian coordinates
    const x3d = radius * Math.cos(phi) * Math.sin(theta);
    const y3d = -radius * Math.sin(phi);  // Negative because y is flipped in equirect
    const z3d = -radius * Math.cos(phi) * Math.cos(theta);
    
    return { x: x3d, y: y3d, z: z3d };
}

// Billboard sprite component for pins
if (typeof AFRAME !== 'undefined' && !AFRAME.components['pin-sprite']) {
    AFRAME.registerComponent('pin-sprite', {
        schema: {
            src: { type: 'asset' },
            size: { default: 1.2 }
        },
        init() {
            const THREERef = AFRAME.THREE;
            this.THREERef = THREERef;
            this.loader = new THREERef.TextureLoader();
            this.loader.crossOrigin = 'anonymous';
            this.sprite = null;
        },
        update() {
            if (!this.data.src) return;
            const { src, size } = this.data;
            this.loader.load(src, (texture) => {
                if (this.sprite) {
                    this.el.removeObject3D('mesh');
                }
                const material = new this.THREERef.SpriteMaterial({ map: texture, transparent: true, depthTest: true });
                const sprite = new this.THREERef.Sprite(material);
                sprite.scale.set(size, size, 1);
                this.el.setObject3D('mesh', sprite);
                this.sprite = sprite;
            });
        },
        remove() {
            if (this.sprite) {
                this.el.removeObject3D('mesh');
                this.sprite = null;
            }
        }
    });
}

function threeDToEquirect(x, y, z) {
    const radius = Math.sqrt(x * x + y * y + z * z);
    if (!radius) return { x: 0, y: 0 };
    const phi = Math.asin(-y / radius);
    const theta = Math.atan2(x, -z);
    const u = (theta / (Math.PI * 2)) + 0.5;
    const v = (phi / Math.PI) + 0.5;
    return {
        x: u * EQUIRECT_WIDTH,
        y: v * EQUIRECT_HEIGHT
    };
}

// DOM Elements
const skyImage = document.getElementById('sky-image');
const stepIndicator = document.getElementById('step-indicator');
const prevBtn = document.getElementById('prev-btn');
const nextBtn = document.getElementById('next-btn');
const loadingOverlay = document.getElementById('loading-overlay');
const minimapSvg = document.getElementById('minimap-svg');
const exportButton = document.getElementById('export-button');
const addCommentBtn = document.getElementById('add-comment-btn');
const zoomInBtn = document.getElementById('zoom-in');
const zoomOutBtn = document.getElementById('zoom-out');
const zoomLevel = document.getElementById('zoom-level');
const minimapContainer = document.getElementById('minimap-container');
const minimapToggle = document.getElementById('minimap-toggle');
const floorDropdown = document.getElementById('floor-dropdown');
const commentPinsContainer = document.getElementById('comment-pins');
const commentPopup = document.getElementById('comment-popup');
const commentOverlay = document.getElementById('comment-overlay');
const commentTitle = document.getElementById('comment-title');
const commentDescription = document.getElementById('comment-description');
const commentRiskBadge = document.getElementById('comment-risk-badge');
const commentClose = document.getElementById('comment-close');
const commentDelete = document.getElementById('comment-delete');
const commentThreadList = document.getElementById('comment-thread-list');
const commentThreadCount = document.getElementById('comment-thread-count');
const commentReplyInput = document.getElementById('comment-reply-input');
const commentReplySend = document.getElementById('comment-reply-send');
const commentTooltip2D = document.getElementById('comment-tooltip-2d');
const connectionErrorOverlay = document.getElementById('connection-error-overlay');
const connectionErrorRetry = document.getElementById('connection-error-retry');
const commentsViewerContainer = document.getElementById('comments-viewer-container');
const viewCommentsBtn = document.getElementById('view-comments-btn');
const commentsListContent = document.getElementById('comments-list-content');
const commentsCountBadge = document.getElementById('comments-count-badge');
const resolvedCommentsTrigger = document.getElementById('resolved-comments-trigger');
const resolvedCommentsPanel = document.getElementById('resolved-comments-panel');
const resolvedCommentsList = document.getElementById('resolved-comments-list');
const resolvedPanelOverlay = document.getElementById('resolved-panel-overlay');
const resolvedPanelClose = document.getElementById('resolved-panel-close');
const addCommentHint = document.getElementById('add-comment-hint');
const addCommentComposer = document.getElementById('add-comment-composer');
const addCommentInput = document.getElementById('add-comment-input');
const addCommentRisk = document.getElementById('add-comment-risk');
const addCommentSave = document.getElementById('add-comment-save');
const addCommentCancel = document.getElementById('add-comment-cancel');

// Parse SVG path and extract vertices
function parsePathVertices(pathData) {
    const vertices = [];
    // Split by commands and filter out empty strings
    const parts = pathData.split(/([MLHVCSQTAZ])/i).filter(p => p.trim());
    
    let currentX = 0;
    let currentY = 0;
    let vertexCount = 0;
    
    for (let i = 0; i < parts.length; i++) {
        const command = parts[i];
        
        if (command === 'M' || command === 'L') {
            // Move or Line command - has x,y coordinates
            i++;
            const coords = parts[i].trim().split(/\s+/);
            currentX = parseFloat(coords[0]);
            currentY = parseFloat(coords[1]);
            vertexCount++;
            vertices.push({ x: currentX, y: currentY, step: vertexCount });
        } else if (command === 'H') {
            // Horizontal line - only x coordinate
            i++;
            currentX = parseFloat(parts[i].trim());
            vertexCount++;
            vertices.push({ x: currentX, y: currentY, step: vertexCount });
        }
    }
    
    // Return vertices up to total steps for current floor
    const totalSteps = getTotalSteps();
    console.log(`Found ${vertices.length} vertices in SVG path for ${getCurrentFloorConfig().name}`);
    return vertices.slice(0, totalSteps);
}

// Create minimap with clickable vertices
async function createMinimap() {
    try {
        // Load the SVG for current floor
        const config = getCurrentFloorConfig();
        const response = await fetch(config.svgPath);
        const svgText = await response.text();
        
        // Parse the SVG
        const parser = new DOMParser();
        const svgDoc = parser.parseFromString(svgText, 'image/svg+xml');
        const pathElement = svgDoc.querySelector('path');
        const pathData = pathElement.getAttribute('d');
        
        // Get original SVG dimensions
        const svgElement = svgDoc.querySelector('svg');
        const viewBox = svgElement.getAttribute('viewBox').split(' ');
        const svgWidth = parseFloat(viewBox[2]);
        const svgHeight = parseFloat(viewBox[3]);
        
        // Create a new SVG for the minimap
        const minimapSvgElement = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        minimapSvgElement.setAttribute('viewBox', `0 0 ${svgWidth} ${svgHeight}`);
        minimapSvgElement.setAttribute('preserveAspectRatio', 'xMidYMid slice');
        
        // Add the path to the minimap
        const minimapPath = pathElement.cloneNode(true);
        minimapPath.style.opacity = '0.5';
        minimapPath.setAttribute('fill', 'none'); // Ensure no fill
        minimapPath.setAttribute('stroke', '#2EA2F5'); // Keep the blue stroke
        minimapPath.setAttribute('stroke-width', '25');
        minimapSvgElement.appendChild(minimapPath);
        
        // Parse vertices
        const vertices = parsePathVertices(pathData);
        
        // Create clickable circles for each vertex
        vertices.forEach((vertex, index) => {
            // Create group for vertex
            const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            group.setAttribute('data-step', vertex.step);
            group.style.cursor = 'pointer';
            
            // Create circle
            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.setAttribute('cx', vertex.x);
            circle.setAttribute('cy', vertex.y);
            circle.setAttribute('r', '60'); // Larger for better click target
            circle.classList.add('path-vertex');
            circle.setAttribute('data-step', vertex.step);
            
            // Add risk level class if this step has comments
            const riskLevel = getRiskLevelForStep(currentFloor, vertex.step);
            if (riskLevel) {
                circle.classList.add(`risk-${riskLevel}`);
            }
            
            // Add click event to the entire group
            group.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const stepNum = parseInt(vertex.step);
                if (!isLoading && stepNum !== currentStep) {
                    console.log(`Minimap click: Step ${stepNum}`);
                    setStep(stepNum);
                }
            });
            
            // Add hover effects
            group.addEventListener('mouseenter', () => {
                if (parseInt(vertex.step) !== currentStep) {
                    circle.style.transform = 'scale(1.15)';
                    circle.style.transformOrigin = `${vertex.x}px ${vertex.y}px`;
                }
            });
            
            group.addEventListener('mouseleave', () => {
                circle.style.transform = 'scale(1)';
            });
            
            group.appendChild(circle);
            minimapSvgElement.appendChild(group);
        });
        
        // Add the SVG to the minimap container
        minimapSvg.appendChild(minimapSvgElement);
        
        // Update the active vertex
        updateMinimapActiveVertex();
        
    } catch (error) {
        console.error('Error creating minimap:', error);
        // Hide minimap if it fails to load
        document.getElementById('minimap-container').style.display = 'none';
    }
}

// Update active vertex on minimap
function updateMinimapActiveVertex() {
    const vertices = minimapSvg.querySelectorAll('.path-vertex');
    vertices.forEach(vertex => {
        const step = parseInt(vertex.getAttribute('data-step'));
        if (step === currentStep) {
            vertex.classList.add('active');
        } else {
            vertex.classList.remove('active');
        }
    });
}

// Toggle minimap minimize/maximize
function toggleMinimap() {
    isMinimapMinimized = !isMinimapMinimized;
    
    if (isMinimapMinimized) {
        minimapContainer.classList.add('minimized');
        minimapToggle.textContent = '+';
        minimapToggle.title = 'Maximize minimap';
    } else {
        minimapContainer.classList.remove('minimized');
        minimapToggle.textContent = '−';
        minimapToggle.title = 'Minimize minimap';
    }
}

// Populate comments list
function populateCommentsList() {
    commentsListContent.innerHTML = '';
    let totalComments = 0;
    
    const floorOrder = ['ground', '3rd', 'roof'];
    const floorNames = {
        'ground': 'Ground Floor',
        '3rd': '3rd Floor',
        'roof': 'Roof'
    };
    
    floorOrder.forEach(floorKey => {
        const floorComments = getAllCommentsForFloor(floorKey);
        if (!floorComments || Object.keys(floorComments).length === 0) return;
        
        const floorGroup = document.createElement('div');
        floorGroup.className = 'comments-floor-group';
        
        const floorTitle = document.createElement('div');
        floorTitle.className = 'comments-floor-title';
        floorTitle.textContent = floorNames[floorKey];
        floorGroup.appendChild(floorTitle);
        
        Object.keys(floorComments).sort((a, b) => parseInt(a) - parseInt(b)).forEach(stepNum => {
            const stepComments = floorComments[stepNum];
            totalComments += stepComments.length;
            stepComments.forEach(comment => {
                const commentItem = document.createElement('div');
                commentItem.className = `comment-item risk-${comment.risk}`;
                
                const contentDiv = document.createElement('div');
                contentDiv.className = 'comment-item-content';
                
                const titleDiv = document.createElement('div');
                titleDiv.className = 'comment-item-title';
                titleDiv.textContent = comment.title;
                
                const metaRow = document.createElement('div');
                metaRow.className = 'comment-item-meta';
                
                const stepDiv = document.createElement('div');
                stepDiv.className = 'comment-item-step';
                stepDiv.textContent = `Step ${stepNum}`;
                
                const riskChip = document.createElement('span');
                riskChip.className = `comment-risk-chip risk-${comment.risk}`;
                riskChip.textContent = `${comment.risk.charAt(0).toUpperCase()}${comment.risk.slice(1)} risk`;
                
                metaRow.appendChild(stepDiv);
                metaRow.appendChild(riskChip);
                
                contentDiv.appendChild(titleDiv);
                contentDiv.appendChild(metaRow);
                
                commentItem.appendChild(contentDiv);
                
                // Add AI badge for high and medium risk
                if (comment.risk === 'high' || comment.risk === 'medium') {
                    const badgesDiv = document.createElement('div');
                    badgesDiv.className = 'comment-item-badges';
                    
                    const aiBadge = document.createElement('span');
                    aiBadge.className = 'comment-ai-badge';
                    aiBadge.textContent = 'AI';
                    
                    badgesDiv.appendChild(aiBadge);
                    commentItem.appendChild(badgesDiv);
                }
                
                // Click handler to navigate to that floor and step
                commentItem.addEventListener('click', async () => {
                    pendingLookAt = { x: comment.x, y: comment.y, yawOffset: 0 };
                    // Close the comments list
                    commentsViewerContainer.classList.remove('active');
                    
                    // If different floor, switch to it
                    if (floorKey !== currentFloor) {
                        await switchFloor(floorKey);
                    }
                    
                    // Navigate to the step
                    await setStep(parseInt(stepNum));
                });
                
                floorGroup.appendChild(commentItem);
            });
        });
        
        commentsListContent.appendChild(floorGroup);
    });
    
    if (commentsCountBadge) {
        commentsCountBadge.textContent = `${totalComments} open`;
    }
}

// Load resolved comments from JSON
async function loadResolvedComments() {
    if (resolvedCommentsCache.length > 0) return resolvedCommentsCache;
    
    try {
        const response = await fetch('./data/resolved_comments/resolved_comments.json');
        if (!response.ok) throw new Error(`Failed to load resolved comments: ${response.status}`);
        const data = await response.json();
        resolvedCommentsCache = Array.isArray(data) ? data : [];
    } catch (error) {
        console.error('Error fetching resolved comments', error);
        resolvedCommentsCache = [];
    }
    
    return resolvedCommentsCache;
}

function getResolvedRiskKey(riskLevel = '') {
    const normalized = riskLevel.toLowerCase();
    if (normalized.includes('high')) return 'high';
    if (normalized.includes('medium')) return 'medium';
    if (normalized.includes('info')) return 'info';
    return 'normal';
}

function populateResolvedCommentsList(comments) {
    resolvedCommentsList.innerHTML = '';
    
    if (!comments || comments.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'resolved-empty';
        empty.textContent = 'No resolved comments available yet.';
        resolvedCommentsList.appendChild(empty);
        return;
    }
    
    comments.forEach(comment => {
        const card = document.createElement('div');
        card.className = 'resolved-card';
        
        const header = document.createElement('div');
        header.className = 'resolved-card-header';
        
        const riskKey = getResolvedRiskKey(comment.riskLevel || '');
        
        const riskDot = document.createElement('span');
        riskDot.className = `resolved-risk-dot risk-${riskKey}`;
        
        const title = document.createElement('div');
        title.className = 'resolved-card-title';
        title.textContent = comment.title;
        
        const badge = document.createElement('span');
        badge.className = `resolved-card-pill risk-${riskKey}`;
        badge.textContent = comment.riskLevel;
        
        header.appendChild(riskDot);
        header.appendChild(title);
        header.appendChild(badge);
        
        const meta = document.createElement('div');
        meta.className = 'resolved-card-meta';
        meta.textContent = comment.location;
        
        const description = document.createElement('p');
        description.className = 'resolved-card-description';
        description.textContent = comment.description;
        
        card.appendChild(header);
        card.appendChild(meta);
        card.appendChild(description);
        
        resolvedCommentsList.appendChild(card);
    });
}

async function openResolvedCommentsPanel() {
    const comments = await loadResolvedComments();
    populateResolvedCommentsList(comments);
    resolvedCommentsPanel.classList.add('active');
    resolvedPanelOverlay.classList.add('active');
}

function closeResolvedCommentsPanel() {
    resolvedCommentsPanel.classList.remove('active');
    resolvedPanelOverlay.classList.remove('active');
}

// Toggle comments list
function toggleCommentsList() {
    commentsViewerContainer.classList.toggle('active');
}

// Create comment pins for current step
function createCommentPins() {
    console.log(`Creating comment pins for floor: ${currentFloor}, step: ${currentStep}`);
    
    // Clear existing pins
    while (commentPinsContainer.firstChild) {
        commentPinsContainer.removeChild(commentPinsContainer.firstChild);
    }
    
    // Get comments for current floor and step
    const stepComments = getStepComments(currentFloor, currentStep);
    
    console.log(`Found ${stepComments.length} comments for this step`);
    
    // Create a pin for each comment
    stepComments.forEach((comment, index) => {
        const commentData = { ...comment, _meta: { floor: currentFloor, step: currentStep } };
        console.log(`Creating pin ${index + 1}:`, commentData.title, `at (${commentData.x}, ${commentData.y})`);
        
        // Convert equirectangular coordinates to 3D position (slightly in front of sky to avoid distortion)
        const pos3d = equirectTo3D(commentData.x, commentData.y, 7.9);
        console.log(`3D position:`, pos3d);
        
        // Create container for the pin
        const pinContainer = document.createElement('a-entity');
        pinContainer.setAttribute('position', `${pos3d.x} ${pos3d.y} ${pos3d.z}`);
        pinContainer.setAttribute('class', 'comment-pin-container');
        
        // Determine which SVG icon to use based on risk level
        let iconPath = './data/icons/comments/normal_risk.svg';
        if (commentData.risk === 'high') {
            iconPath = './data/icons/comments/high_risk.svg';
        } else if (commentData.risk === 'medium') {
            iconPath = './data/icons/comments/medium_risk.svg';
        } else if (commentData.risk === 'info') {
            iconPath = './data/icons/comments/info.svg';
        }
        
        console.log(`Using icon: ${iconPath}`);
        
        // Wrapper keeps simple animations and faces camera
        const pinIcon = document.createElement('a-entity');
        pinIcon.setAttribute('position', '0 0 0');
        pinIcon.setAttribute('class', 'comment-pin-wrapper');
        pinIcon.setAttribute('look-at', '[camera]');
        
        const iconPlane = document.createElement('a-plane');
        iconPlane.setAttribute('src', iconPath);
        iconPlane.setAttribute('width', '1.275');
        iconPlane.setAttribute('height', '1.275');
        iconPlane.setAttribute('material', 'transparent: true; alphaTest: 0.1; shader: flat; side: double');
        iconPlane.setAttribute('scale', '1 1 1');
        iconPlane.setAttribute('class', 'comment-pin');
        iconPlane.setAttribute('data-comment-index', index);
        pinIcon.appendChild(iconPlane);
        
        // Add pulsating animation to wrapper (smaller scale to keep it sharp)
        pinIcon.setAttribute('animation__pulse', 'property: scale; to: 1.05 1.05 1.05; dir: alternate; loop: true; dur: 1500; easing: easeInOutSine');
        
        // Add animations for hover and click (reduce scale to prevent blur)
        iconPlane.setAttribute('animation__mouseenter', 'property: scale; to: 1.15 1.15 1.15; dur: 200; startEvents: mouseenter; pauseEvents: mouseleave');
        iconPlane.setAttribute('animation__mouseleave', 'property: scale; to: 1 1 1; dur: 200; startEvents: mouseleave');
        
        // Show/hide 2D tooltip on hover
        iconPlane.addEventListener('mouseenter', (e) => {
            commentTooltip2D.textContent = commentData.title;
            commentTooltip2D.classList.add('visible');
        });
        
        iconPlane.addEventListener('mouseleave', () => {
            commentTooltip2D.classList.remove('visible');
        });
        
        // Add click handler
        iconPlane.addEventListener('click', () => {
            if (isAddCommentMode) return;
            commentTooltip2D.classList.remove('visible'); // Hide tooltip immediately
            showCommentPopup(commentData);
        });
        
        // Add to container
        pinContainer.appendChild(pinIcon);

        // Add to scene
        commentPinsContainer.appendChild(pinContainer);
        
        console.log(`Pin ${index + 1} added to scene`);
    });

    console.log(`Comment pins creation complete. Total pins in container: ${commentPinsContainer.children.length}`);
}

function getCommentThreadKey(comment) {
    const title = (comment.title || 'comment').toLowerCase();
    return `${currentFloor}-${currentStep}-${title}`;
}

function seedCommentThread(comment) {
    const key = getCommentThreadKey(comment);
    if (!commentThreads[key]) {
        const isAIRisk = comment.risk === 'high' || comment.risk === 'medium';
        const starterText = comment.risk === 'high'
            ? 'High priority flag. Add a quick update.'
            : 'Logged during the walkthrough. Reply here with any updates.';
        commentThreads[key] = [
            {
                author: isAIRisk ? 'AI Assist' : 'Field QA',
                time: isAIRisk ? 'Auto-detected' : 'Earlier today',
                text: starterText,
                avatarUrl: isAIRisk ? './data/users/ai_dp.png' : './data/users/field_qa_dp.png'
            }
        ];
    }
    return key;
}

function renderCommentThread(key) {
    if (!commentThreadList) return;
    const thread = commentThreads[key] || [];
    commentThreadList.innerHTML = '';

    if (thread.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'comment-thread-empty';
        empty.textContent = 'No replies yet. Start the thread.';
        commentThreadList.appendChild(empty);
    } else {
        thread.forEach(entry => {
            const item = document.createElement('div');
            item.className = 'comment-thread-item';

            const avatar = document.createElement('div');
            avatar.className = 'comment-thread-avatar';
            if (entry.avatarUrl) {
                const img = document.createElement('img');
                img.src = entry.avatarUrl;
                img.alt = entry.author || 'User';
                avatar.appendChild(img);
            } else {
                avatar.textContent = entry.author ? entry.author.charAt(0).toUpperCase() : '?';
            }

            const body = document.createElement('div');
            body.className = 'comment-thread-body';

            const metaRow = document.createElement('div');
            metaRow.className = 'comment-thread-meta';
            const author = document.createElement('span');
            author.className = 'comment-thread-author';
            author.textContent = entry.author || 'Unknown';
            const time = document.createElement('span');
            time.className = 'comment-thread-time';
            time.textContent = entry.time || 'Just now';
            metaRow.appendChild(author);
            metaRow.appendChild(time);

            const text = document.createElement('div');
            text.className = 'comment-thread-text';
            text.textContent = entry.text || '';

            body.appendChild(metaRow);
            body.appendChild(text);

            item.appendChild(avatar);
            item.appendChild(body);
            commentThreadList.appendChild(item);
        });
    }

    if (commentThreadCount) {
        const label = thread.length === 1 ? 'Reply' : 'Replies';
        commentThreadCount.textContent = `${thread.length} ${label}`;
    }

    requestAnimationFrame(() => {
        commentThreadList.scrollTop = commentThreadList.scrollHeight;
    });
}

function updateReplyButtonState() {
    if (!commentReplySend || !commentReplyInput) return;
    commentReplySend.disabled = getReplyPlainText().length === 0 || !activeCommentKey;
}

function handleReplySubmit() {
    if (!commentReplyInput || !activeCommentKey) return;
    const message = getReplyPlainText();
    if (!message) {
        updateReplyButtonState();
        return;
    }

    commentThreads[activeCommentKey] = commentThreads[activeCommentKey] || [];
    commentThreads[activeCommentKey].push({
        author: 'You',
        time: 'Just now',
        text: message
    });

    commentReplyInput.innerHTML = '';
    renderCommentThread(activeCommentKey);
    updateReplyButtonState();
}

// Show comment popup
function showCommentPopup(comment) {
    activeCommentRef = { comment, floor: comment._meta?.floor || currentFloor, step: comment._meta?.step || currentStep };
    commentTitle.textContent = comment.title;
    commentDescription.textContent = comment.description;
    
    // Update badge text and color based on risk level
    if (comment.risk === 'info') {
        commentRiskBadge.textContent = 'INFO';
        commentRiskBadge.style.background = '#49CA29';
    } else {
        commentRiskBadge.textContent = `${comment.risk.toUpperCase()} RISK`;
        
        if (comment.risk === 'normal') {
            commentRiskBadge.style.background = '#0C8CE9';
        } else if (comment.risk === 'high') {
            commentRiskBadge.style.background = '#FF4E4E';
        } else if (comment.risk === 'medium') {
            commentRiskBadge.style.background = '#FFB54C';
        }
    }
    
    activeCommentKey = seedCommentThread(comment);
    renderCommentThread(activeCommentKey);
    if (commentReplyInput) {
        commentReplyInput.innerHTML = '';
        renderReplyInput();
    }
    updateReplyButtonState();

    if (commentDelete) {
        const shouldShowDelete = Boolean(comment.isUser);
        commentDelete.style.display = shouldShowDelete ? 'inline-flex' : 'none';
    }

    commentPopup.classList.add('visible');
    commentOverlay.classList.add('visible');
}

// Hide comment popup
function hideCommentPopup() {
    commentPopup.classList.remove('visible');
    commentOverlay.classList.remove('visible');
    commentTooltip2D.classList.remove('visible'); // Also hide tooltip if it's stuck
    activeCommentRef = null;
    activeCommentKey = null;
    if (commentReplyInput) {
        commentReplyInput.innerHTML = '';
        renderReplyInput();
    }
    updateReplyButtonState();
}

// Export current view as image
function exportCurrentView() {
    try {
        const scene = document.querySelector('a-scene');
        
        // Wait for scene to be ready and rendered
        if (!scene || !scene.hasLoaded) {
            alert('Scene is still loading. Please try again in a moment.');
            return;
        }
        
        console.log('Starting export...');
        
        // Method 1: Use A-Frame's built-in screenshot component
        if (scene.components && scene.components.screenshot) {
            console.log('Using A-Frame screenshot component');
            const filename = `Boomerang_Club_Step_${currentStep}_${new Date().toISOString().slice(0, 10)}`;
            scene.components.screenshot.capture('perspective', filename);
            return;
        }
        
        // Method 2: Manual canvas capture with enhanced settings
        setTimeout(() => {
            try {
                // Force a render first
                if (scene.renderer && scene.camera) {
                    scene.renderer.render(scene.object3D, scene.camera);
                }
                
                // Get canvas with multiple fallback methods
                let canvas = null;
                
                // Try different canvas access methods
                if (scene.canvas) {
                    canvas = scene.canvas;
                } else if (scene.renderer && scene.renderer.domElement) {
                    canvas = scene.renderer.domElement;
                } else {
                    // DOM query fallback
                    canvas = scene.querySelector('canvas') || 
                            document.querySelector('a-scene canvas') ||
                            document.querySelector('canvas[data-engine="three.js r150"]') ||
                            document.querySelector('canvas');
                }
                
                if (!canvas) {
                    throw new Error('Canvas not found');
                }
                
                console.log('Canvas found:', {
                    width: canvas.width,
                    height: canvas.height,
                    className: canvas.className,
                    context: canvas.getContext ? 'available' : 'not available'
                });
                
                // Method 2a: Try toBlob first (more reliable for large images)
                const exportWithBlob = () => {
                    canvas.toBlob((blob) => {
                        if (blob && blob.size > 1000) {
                            const url = URL.createObjectURL(blob);
                            const link = document.createElement('a');
                            link.href = url;
                            link.download = `Boomerang_Club_Step_${currentStep}_${new Date().toISOString().slice(0, 10)}.png`;
                            document.body.appendChild(link);
                            link.click();
                            document.body.removeChild(link);
                            URL.revokeObjectURL(url);
                            console.log('Export successful via blob');
                        } else {
                            // Fallback to dataURL
                            exportWithDataURL();
                        }
                    }, 'image/png', 1.0);
                };
                
                // Method 2b: DataURL fallback
                const exportWithDataURL = () => {
                    try {
                        const dataURL = canvas.toDataURL('image/png', 1.0);
                        
                        // Check if image is valid (not blank/empty)
                        if (dataURL && dataURL.length > 1000 && 
                            !dataURL.includes('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==')) {
                            
                            const link = document.createElement('a');
                            link.href = dataURL;
                            link.download = `Boomerang_Club_Step_${currentStep}_${new Date().toISOString().slice(0, 10)}.png`;
                            document.body.appendChild(link);
                            link.click();
                            document.body.removeChild(link);
                            console.log('Export successful via dataURL');
                        } else {
                            throw new Error('Canvas appears to be blank or empty');
                        }
                    } catch (error) {
                        console.error('DataURL export failed:', error);
                        alert('Export failed: Canvas could not be captured. This may be due to WebGL restrictions or cross-origin issues.');
                    }
                };
                
                // Start with blob method
                exportWithBlob();
                
            } catch (error) {
                console.error('Manual canvas export error:', error);
                alert('Export failed: ' + error.message);
            }
        }, 300); // Longer delay to ensure rendering is complete
        
    } catch (error) {
        console.error('Export function error:', error);
        alert('Export failed: ' + error.message);
    }
}

// Update zoom level
const MIN_ZOOM = 75;
const MAX_ZOOM = 150;

function applyZoomLevel(newZoom) {
    const clamped = Math.min(Math.max(newZoom, MIN_ZOOM), MAX_ZOOM);
    const rounded = Math.round(clamped / 5) * 5; // keep to whole-number steps (5% granularity)
    const normalized = Math.round(rounded); // avoid floating artifacts
    currentZoom = normalized;
    
    const camera = document.querySelector('a-camera');
    if (camera) {
        const baseFov = 80; // Default A-Frame FOV
        const newFov = baseFov * (100 / currentZoom);
        camera.setAttribute('camera', 'fov', newFov);
    }
    
    // Update zoom level display
    if (zoomLevel) {
        zoomLevel.textContent = `${Math.round(currentZoom)}%`;
    }
    
    // Update button states
    if (zoomInBtn && zoomOutBtn) {
        zoomInBtn.disabled = currentZoom >= MAX_ZOOM;
        zoomOutBtn.disabled = currentZoom <= MIN_ZOOM;
    }
}

function updateZoom(direction) {
    const zoomStep = 5;
    
    if (direction === 'in') {
        applyZoomLevel(currentZoom + zoomStep);
    } else if (direction === 'out') {
        applyZoomLevel(currentZoom - zoomStep);
    } else if (direction === 'reset') {
        applyZoomLevel(100); // Reset to default
    }
}

function handleWheelZoom(event) {
    // Use pinch-to-zoom (trackpad) gesture: browsers set ctrlKey on wheel during pinch
    if (!event.ctrlKey) return;
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
    
    const sensitivity = 0.35; // Balanced for Chrome trackpad deltas
    wheelDeltaBuffer += -event.deltaY * sensitivity;
    // Prevent runaway accumulation
    wheelDeltaBuffer = Math.max(Math.min(wheelDeltaBuffer, 20), -20);
    
    const previousZoom = currentZoom;
    applyZoomLevel(currentZoom + wheelDeltaBuffer);
    
    // If zoom actually changed (crossed a 5% step), reset buffer for snappier feel
    if (currentZoom !== previousZoom) {
        wheelDeltaBuffer = 0;
    }
}

function handleGestureStart(event) {
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
    lastGestureScale = event.scale || 1;
}

function handleGestureChange(event) {
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
    const currentScale = event.scale || 1;
    const deltaScale = currentScale - lastGestureScale;
    const gestureSensitivity = 80; // Tune for Safari pinch gestures
    applyZoomLevel(currentZoom + deltaScale * gestureSensitivity);
    lastGestureScale = currentScale;
}

function handleGestureEnd(event) {
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
    lastGestureScale = 1;
}

function bindGestureListeners() {
    if (gestureListenersBound) return;
    const opts = { passive: false, capture: true };
    window.addEventListener('wheel', handleWheelZoom, opts);
    window.addEventListener('gesturestart', handleGestureStart, opts);
    window.addEventListener('gesturechange', handleGestureChange, opts);
    window.addEventListener('gestureend', handleGestureEnd, opts);
    document.addEventListener('gesturestart', handleGestureStart, opts);
    document.addEventListener('gesturechange', handleGestureChange, opts);
    document.addEventListener('gestureend', handleGestureEnd, opts);
    gestureListenersBound = true;
}

// Generate image URL for a given step
function getImageUrl(step) {
    const config = getCurrentFloorConfig();
    // Format: step-01.jpg, step-02.jpg, etc. (zero-padded to 2 digits)
    const paddedStep = String(step).padStart(2, '0');
    return `${config.imageDir}step-${paddedStep}${EXT}`;
}

// Preload an image
function preloadImage(step) {
    return new Promise((resolve, reject) => {
        const url = getImageUrl(step);
        
        // Check if already cached
        if (imageCache.has(step)) {
            resolve(url);
            return;
        }
        
        const img = new Image();
        img.crossOrigin = 'anonymous'; // Enable CORS for canvas export
        img.onload = () => {
            imageCache.set(step, img);
            resolve(url);
        };
        img.onerror = () => {
            console.error(`Failed to load image for step ${step}`);
            reject(new Error(`Failed to load ${url}`));
        };
        img.src = url;
    });
}

// Show loading overlay
function showLoading() {
    loadingOverlay.classList.add('visible');
    isLoading = true;
}

// Hide loading overlay
function hideLoading() {
    loadingOverlay.classList.remove('visible');
    isLoading = false;
}

// Show connection error overlay
function showConnectionError() {
    connectionErrorOverlay.classList.add('visible');
}

// Hide connection error overlay
function hideConnectionError() {
    connectionErrorOverlay.classList.remove('visible');
}

// Update the current step
async function setStep(step, skipAnimation = false) {
    const totalSteps = getTotalSteps();
    if (isLoading || step < 1 || step > totalSteps) return;
    
    // Check if image is already cached - if so, skip loading overlay for instant display
    const isImageCached = imageCache.has(step);
    
    if (!isImageCached) {
        showLoading();
    }
    
    try {
        // Preload the image (will resolve immediately if cached)
        const url = await preloadImage(step);
        
        // Update the sky with crossfade
        if (!skipAnimation) {
            skyImage.style.animation = 'none';
            setTimeout(() => {
                skyImage.style.animation = 'fadeIn 0.25s ease-out';
            }, 10);
        }
        
        skyImage.setAttribute('src', url);
        currentStep = step;
        
        // Update UI
        stepIndicator.textContent = `Step ${currentStep}/${totalSteps}`;
        prevBtn.disabled = currentStep === 1;
        nextBtn.disabled = currentStep === totalSteps;
        
        // Update minimap
        updateMinimapActiveVertex();
        
        // Update comment pins
        createCommentPins();
        applyPendingLookAt();
        
        // Preload next images
        for (let i = 1; i <= PRELOAD_AHEAD; i++) {
            const nextStep = currentStep + i;
            if (nextStep <= totalSteps) {
                preloadImage(nextStep).catch(() => {
                    // Ignore preload errors
                });
            }
        }
        
        // Preload previous images too
        for (let i = 1; i <= PRELOAD_AHEAD; i++) {
            const prevStep = currentStep - i;
            if (prevStep >= 1) {
                preloadImage(prevStep).catch(() => {
                    // Ignore preload errors
                });
            }
        }
        
        // Hide loading instantly for smooth UX (only if we showed it)
        if (!isImageCached) {
            hideLoading();
        }
        
    } catch (error) {
        console.error('Error loading step:', error);
        if (!isImageCached) {
            hideLoading();
        }
        showConnectionError();
    }
}

// Navigation functions
function goToNext() {
    const totalSteps = getTotalSteps();
    if (currentStep < totalSteps) {
        setStep(currentStep + 1);
    } else {
        // Wrap around to beginning
        setStep(1);
    }
}

function goToPrev() {
    const totalSteps = getTotalSteps();
    if (currentStep > 1) {
        setStep(currentStep - 1);
    } else {
        // Wrap around to end
        setStep(totalSteps);
    }
}

// Switch between floors
async function switchFloor(floorKey) {
    if (isLoading || floorKey === currentFloor) return;
    
    console.log(`Switching from ${currentFloor} to ${floorKey}`);
    
    currentFloor = floorKey;
    currentStep = 1;
    imageCache.clear(); // Clear cache when switching floors
    
    // Update dropdown value
    floorDropdown.value = floorKey;
    
    // Update minimap background
    const config = getCurrentFloorConfig();
    const minimapBg = document.querySelector('.minimap-bg');
    minimapBg.src = config.bgImage;
    
    // Recreate minimap for new floor
    const minimapSvgContainer = document.getElementById('minimap-svg');
    minimapSvgContainer.innerHTML = '';
    await createMinimap();
    
    // Load first step of new floor
    await setStep(1, false);
}

// Event listeners
prevBtn.addEventListener('click', goToPrev);
nextBtn.addEventListener('click', goToNext);

// Floor dropdown event listener
floorDropdown.addEventListener('change', (e) => {
    switchFloor(e.target.value);
});

// Connection error retry button
connectionErrorRetry.addEventListener('click', () => {
    hideConnectionError();
    setStep(currentStep); // Retry loading the current step
});

// Export and zoom event listeners
exportButton.addEventListener('click', exportCurrentView);
zoomInBtn.addEventListener('click', () => updateZoom('in'));
zoomOutBtn.addEventListener('click', () => updateZoom('out'));
bindGestureListeners();

// Minimap toggle event listener
minimapToggle.addEventListener('click', toggleMinimap);

// Comments list event listener
viewCommentsBtn.addEventListener('click', toggleCommentsList);
resolvedCommentsTrigger.addEventListener('click', async (e) => {
    e.stopPropagation();
    await openResolvedCommentsPanel();
});
resolvedPanelOverlay.addEventListener('click', closeResolvedCommentsPanel);
resolvedPanelClose.addEventListener('click', closeResolvedCommentsPanel);

// Close comments list when clicking outside
document.addEventListener('click', (e) => {
    if (commentsViewerContainer.classList.contains('active') && 
        !commentsViewerContainer.contains(e.target)) {
        commentsViewerContainer.classList.remove('active');
    }
});

// Comment popup event listeners
commentClose.addEventListener('click', hideCommentPopup);
commentOverlay.addEventListener('click', hideCommentPopup);
if (commentReplyInput) {
    commentReplyInput.addEventListener('input', () => {
        renderReplyInput();
        updateReplyButtonState();
    });
    commentReplyInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleReplySubmit();
        }
    });
}

if (commentReplySend) {
    commentReplySend.addEventListener('click', handleReplySubmit);
}

if (addCommentBtn) {
    addCommentBtn.addEventListener('click', () => {
        setAddCommentMode(!isAddCommentMode);
    });
}

if (skyImage) {
    skyImage.addEventListener('click', handleSceneClickForCommentPlacement);
}

if (addCommentInput) {
    addCommentInput.addEventListener('input', updateAddComposerState);
    addCommentInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            savePendingComment();
        }
    });
}

if (addCommentRisk) {
    addCommentRisk.addEventListener('change', updateAddComposerState);
}

if (addCommentSave) {
    addCommentSave.addEventListener('click', savePendingComment);
}

if (addCommentCancel) {
    addCommentCancel.addEventListener('click', () => {
        pendingAddPosition = null;
        closeAddCommentComposer();
        setAddCommentMode(false);
    });
}

if (commentDelete) {
    commentDelete.addEventListener('click', () => {
        if (!activeCommentRef || !activeCommentRef.comment || !activeCommentRef.comment.isUser) return;
        const { floor, step } = activeCommentRef;
        if (!floor || !step || !userComments[floor] || !userComments[floor][step]) return;
        const targetId = activeCommentRef.comment.id;
        userComments[floor][step] = userComments[floor][step].filter(c => c.id !== targetId);
        hideCommentPopup();
        createCommentPins();
        populateCommentsList();
    });
}

// Tooltip follows mouse cursor
document.addEventListener('mousemove', (e) => {
    if (commentTooltip2D.classList.contains('visible')) {
        commentTooltip2D.style.left = (e.clientX + 15) + 'px';
        commentTooltip2D.style.top = (e.clientY + 15) + 'px';
    }
});

// Keyboard navigation
document.addEventListener('keydown', (e) => {
    const activeEl = document.activeElement;
    const isTyping = activeEl && ((activeEl.tagName === 'INPUT') || (activeEl.tagName === 'TEXTAREA') || activeEl.getAttribute('contenteditable') === 'true');

    if (e.key === 'Escape') {
        if (commentsViewerContainer.classList.contains('active')) {
            commentsViewerContainer.classList.remove('active');
        }
        if (resolvedCommentsPanel.classList.contains('active')) {
            closeResolvedCommentsPanel();
        }
        if (isAddCommentMode) {
            setAddCommentMode(false);
        }
        if (addCommentComposer && addCommentComposer.classList.contains('active')) {
            closeAddCommentComposer();
        }
        return;
    }
    
    if (isTyping) return;
    if (isLoading) return;
    
    switch(e.key) {
        case 'ArrowRight':
            e.preventDefault();
            goToNext();
            break;
        case 'ArrowLeft':
            e.preventDefault();
            goToPrev();
            break;
        case 'Home':
            e.preventDefault();
            setStep(1);
            break;
        case 'End':
            e.preventDefault();
            setStep(getTotalSteps());
            break;
        case '=':
        case '+':
            e.preventDefault();
            updateZoom('in');
            break;
        case '-':
        case '_':
            e.preventDefault();
            updateZoom('out');
            break;
        case 'e':
        case 'E':
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                exportCurrentView();
            }
            break;
        case 'm':
        case 'M':
            e.preventDefault();
            toggleMinimap();
            break;
        case 'c':
        case 'C':
            e.preventDefault();
            setAddCommentMode(!isAddCommentMode);
            break;
        case 'Escape':
            if (commentPopup.classList.contains('visible')) {
                e.preventDefault();
                hideCommentPopup();
            }
            break;
    }
});

// Touch swipe support (optional enhancement)
let touchStartX = 0;
let touchEndX = 0;

document.addEventListener('touchstart', (e) => {
    touchStartX = e.changedTouches[0].screenX;
});

document.addEventListener('touchend', (e) => {
    touchEndX = e.changedTouches[0].screenX;
    handleSwipe();
});

function handleSwipe() {
    const swipeThreshold = 50;
    const diff = touchStartX - touchEndX;
    
    if (Math.abs(diff) > swipeThreshold) {
        if (diff > 0) {
            // Swipe left - go next
            goToNext();
        } else {
            // Swipe right - go prev
            goToPrev();
        }
    }
}

// ============================================
// Calendar Date Picker
// ============================================

// Generate calendar for August 2025
function generateCalendar() {
    const calendarDays = document.getElementById('calendar-days');
    if (!calendarDays) return;
    
    // August 2025 starts on a Friday (day 5, where Sunday = 0)
    const firstDayOfMonth = 5; // Friday
    const daysInMonth = 31;
    const selectedDate = 25; // 25th August 2025
    
    calendarDays.innerHTML = '';
    
    // Add empty cells for days before the month starts
    for (let i = 0; i < firstDayOfMonth; i++) {
        const emptyDay = document.createElement('div');
        emptyDay.classList.add('calendar-day', 'empty');
        calendarDays.appendChild(emptyDay);
    }
    
    // Add all days of the month
    for (let day = 1; day <= daysInMonth; day++) {
        const dayElement = document.createElement('div');
        dayElement.classList.add('calendar-day');
        dayElement.textContent = day;
        
        // Only the 25th is selectable, all others are disabled
        if (day === selectedDate) {
            dayElement.classList.add('selected');
            dayElement.title = 'Selected date';
        } else {
            dayElement.classList.add('disabled');
            dayElement.title = 'Date not available';
        }
        
        // Add click handler (even though only 25th is interactive)
        dayElement.addEventListener('click', () => {
            if (day === selectedDate) {
                // Close the calendar when clicking the selected date
                toggleCalendar(false);
            }
        });
        
        calendarDays.appendChild(dayElement);
    }
}

// Toggle calendar visibility
function toggleCalendar(forceState = null) {
    const container = document.querySelector('.date-time-container');
    const picker = document.getElementById('calendar-picker');
    
    if (!container || !picker) return;
    
    if (forceState === null) {
        // Toggle
        container.classList.toggle('active');
    } else if (forceState === true) {
        // Open
        container.classList.add('active');
    } else {
        // Close
        container.classList.remove('active');
    }
}

// Setup date picker event listeners
function setupDatePicker() {
    const dateTimeBtn = document.getElementById('date-time-trigger');
    const calendarPicker = document.getElementById('calendar-picker');
    
    if (!dateTimeBtn || !calendarPicker) return;
    
    // Toggle calendar on date button click
    dateTimeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleCalendar();
    });
    
    // Prevent calendar from closing when clicking inside it
    calendarPicker.addEventListener('click', (e) => {
        e.stopPropagation();
    });
    
    // Close calendar when clicking outside
    document.addEventListener('click', (e) => {
        const container = document.querySelector('.date-time-container');
        if (!container.contains(e.target)) {
            toggleCalendar(false);
        }
    });
    
    // Close calendar on Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            toggleCalendar(false);
        }
    });
    
    // Generate the calendar days
    generateCalendar();
}

// Initialize
window.addEventListener('load', () => {
    // Wait for A-Frame scene to be fully ready before initializing
    const scene = document.querySelector('a-scene');
    
    const initializeApp = () => {
        console.log('Initializing app...');
        
        // Create the minimap (async, but don't wait)
        createMinimap();
        
        // Load the first step
        // Aim slightly to the right of the first comment so it appears just left of center
        const initialComment = COMMENTS['3rd'] && COMMENTS['3rd'][1] && COMMENTS['3rd'][1][0];
        if (initialComment) {
            pendingLookAt = { x: initialComment.x, y: initialComment.y, yawOffset: -12 };
        }
        setStep(1, true);
        
        // Create comment pins immediately - scene should be ready by now
        // Use requestAnimationFrame to ensure DOM is ready
        requestAnimationFrame(() => {
            createCommentPins();
        });
        
        // Initialize zoom controls
        updateZoom('reset'); // Set initial state
        
        // Initialize date picker calendar
        setupDatePicker();
        
        // Populate comments list
        populateCommentsList();
        
        // Show welcome instruction and hide after 5 seconds (or on click)
        const welcomeOverlay = document.getElementById('welcome-overlay');
        if (welcomeOverlay) {
            const hideWelcome = () => {
                welcomeOverlay.classList.add('hidden');
                // Remove from DOM after fade out
                setTimeout(() => {
                    welcomeOverlay.style.display = 'none';
                }, 500);
            };
            
            // Auto-hide after 2 seconds (reduced from 5 for faster startup)
            const autoHideTimer = setTimeout(hideWelcome, 2000);
            
            // Allow click to dismiss early
            welcomeOverlay.addEventListener('click', () => {
                clearTimeout(autoHideTimer);
                hideWelcome();
            });
        }
        
        // Aggressively preload first 10 images for instant navigation
        const totalSteps = getTotalSteps();
        for (let i = 2; i <= Math.min(10, totalSteps); i++) {
            preloadImage(i).catch(() => {
                // Ignore preload errors
            });
        }
    };
    
    // Check if scene is already loaded, otherwise wait for it
    if (scene && scene.hasLoaded) {
        console.log('A-Frame scene already loaded, initializing immediately');
        initializeApp();
    } else if (scene) {
        console.log('Waiting for A-Frame scene to load...');
        scene.addEventListener('loaded', () => {
            console.log('A-Frame scene loaded, initializing app');
            // Initialize immediately - no delay needed
            initializeApp();
        });
    } else {
        console.warn('A-Frame scene not found, initializing anyway');
        initializeApp();
    }
});

// Handle A-Frame scene load errors and start early preloading
document.addEventListener('DOMContentLoaded', () => {
    const scene = document.querySelector('a-scene');
    if (scene) {
        scene.addEventListener('loaded', () => {
            console.log('A-Frame scene loaded successfully');
        });
        
        scene.addEventListener('error', (error) => {
            console.error('A-Frame scene error:', error);
        });
    }
    
    // Start preloading the first image immediately (don't wait for window.load)
    // This gives us a head start on image loading
    console.log('Starting early preload of first image...');
    const firstImageUrl = getImageUrl(1);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
        imageCache.set(1, img);
        console.log('First image preloaded successfully');
    };
    img.onerror = () => {
        console.warn('Early preload of first image failed, will retry on initialization');
    };
    img.src = firstImageUrl;
});
