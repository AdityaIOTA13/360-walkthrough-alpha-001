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

// Helper functions to get current floor config
function getCurrentFloorConfig() {
    return FLOORS[currentFloor];
}

function getTotalSteps() {
    return getCurrentFloorConfig().totalSteps;
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

// DOM Elements
const skyImage = document.getElementById('sky-image');
const stepIndicator = document.getElementById('step-indicator');
const prevBtn = document.getElementById('prev-btn');
const nextBtn = document.getElementById('next-btn');
const loadingOverlay = document.getElementById('loading-overlay');
const minimapSvg = document.getElementById('minimap-svg');
const exportButton = document.getElementById('export-button');
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
const commentTooltip2D = document.getElementById('comment-tooltip-2d');
const connectionErrorOverlay = document.getElementById('connection-error-overlay');
const connectionErrorRetry = document.getElementById('connection-error-retry');

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

// Create comment pins for current step
function createCommentPins() {
    // Clear existing pins
    while (commentPinsContainer.firstChild) {
        commentPinsContainer.removeChild(commentPinsContainer.firstChild);
    }
    
    // Get comments for current floor and step
    const floorComments = COMMENTS[currentFloor] || {};
    const stepComments = floorComments[currentStep] || [];
    
    // Create a pin for each comment
    stepComments.forEach((comment, index) => {
        // Convert equirectangular coordinates to 3D position
        const pos3d = equirectTo3D(comment.x, comment.y);
        
        // Create container for the pin
        const pinContainer = document.createElement('a-entity');
        pinContainer.setAttribute('position', `${pos3d.x} ${pos3d.y} ${pos3d.z}`);
        pinContainer.setAttribute('class', 'comment-pin-container');
        
        // Determine which SVG icon to use based on risk level
        let iconPath = './data/icons/comments/normal_risk.svg';
        if (comment.risk === 'high') {
            iconPath = './data/icons/comments/high_risk.svg';
        } else if (comment.risk === 'medium') {
            iconPath = './data/icons/comments/medium_risk.svg';
        } else if (comment.risk === 'info') {
            iconPath = './data/icons/comments/info.svg';
        }
        
        // Create a circular container to maintain aspect ratio
        const pinIcon = document.createElement('a-entity');
        pinIcon.setAttribute('position', '0 0 0');
        pinIcon.setAttribute('look-at', '[camera]');
        pinIcon.setAttribute('class', 'comment-pin-wrapper');
        
        // Create the actual icon as a plane inside
        const iconPlane = document.createElement('a-plane');
        iconPlane.setAttribute('src', iconPath);
        iconPlane.setAttribute('width', '1.275');
        iconPlane.setAttribute('height', '1.275');
        iconPlane.setAttribute('material', 'transparent: true; alphaTest: 0.1; shader: flat; side: double');
        iconPlane.setAttribute('scale', '1 1 1'); // Force 1:1 aspect ratio
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
            commentTooltip2D.textContent = comment.title;
            commentTooltip2D.classList.add('visible');
        });
        
        iconPlane.addEventListener('mouseleave', () => {
            commentTooltip2D.classList.remove('visible');
        });
        
        // Add click handler
        iconPlane.addEventListener('click', () => {
            commentTooltip2D.classList.remove('visible'); // Hide tooltip immediately
            showCommentPopup(comment);
        });
        
        // Add to container
        pinContainer.appendChild(pinIcon);
        
        // Add to scene
        commentPinsContainer.appendChild(pinContainer);
    });
}

// Show comment popup
function showCommentPopup(comment) {
    commentTitle.textContent = comment.title;
    commentDescription.textContent = comment.description;
    
    // Update badge text and color based on risk level
    if (comment.risk === 'info') {
        commentRiskBadge.textContent = 'INFO';
        commentRiskBadge.style.background = '#22AA00';
    } else {
        commentRiskBadge.textContent = `${comment.risk.toUpperCase()} RISK`;
        
        if (comment.risk === 'normal') {
            commentRiskBadge.style.background = '#0C8CE9';
        } else if (comment.risk === 'high') {
            commentRiskBadge.style.background = '#FF0000';
        } else if (comment.risk === 'medium') {
            commentRiskBadge.style.background = '#FFB54C';
        }
    }
    
    commentPopup.classList.add('visible');
    commentOverlay.classList.add('visible');
}

// Hide comment popup
function hideCommentPopup() {
    commentPopup.classList.remove('visible');
    commentOverlay.classList.remove('visible');
    commentTooltip2D.classList.remove('visible'); // Also hide tooltip if it's stuck
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
function updateZoom(direction) {
    const zoomStep = 25;
    const minZoom = 50;
    const maxZoom = 200;
    
    if (direction === 'in' && currentZoom < maxZoom) {
        currentZoom += zoomStep;
    } else if (direction === 'out' && currentZoom > minZoom) {
        currentZoom -= zoomStep;
    } else if (direction === 'reset') {
        currentZoom = 100; // Reset to default
    }
    
    // Update camera FOV based on zoom
    const camera = document.querySelector('a-camera');
    if (camera) {
        const baseFov = 80; // Default A-Frame FOV
        const newFov = baseFov * (100 / currentZoom);
        camera.setAttribute('camera', 'fov', newFov);
    }
    
    // Update zoom level display
    if (zoomLevel) {
        zoomLevel.textContent = `${currentZoom}%`;
    }
    
    // Update button states
    if (zoomInBtn && zoomOutBtn) {
        zoomInBtn.disabled = currentZoom >= maxZoom;
        zoomOutBtn.disabled = currentZoom <= minZoom;
    }
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
    
    showLoading();
    
    try {
        // Preload the image
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
        
        // Hide loading instantly for smooth UX
        hideLoading();
        
    } catch (error) {
        console.error('Error loading step:', error);
        hideLoading();
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

// Minimap toggle event listener
minimapToggle.addEventListener('click', toggleMinimap);

// Comment popup event listeners
commentClose.addEventListener('click', hideCommentPopup);
commentOverlay.addEventListener('click', hideCommentPopup);

// Tooltip follows mouse cursor
document.addEventListener('mousemove', (e) => {
    if (commentTooltip2D.classList.contains('visible')) {
        commentTooltip2D.style.left = (e.clientX + 15) + 'px';
        commentTooltip2D.style.top = (e.clientY + 15) + 'px';
    }
});

// Keyboard navigation
document.addEventListener('keydown', (e) => {
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

// Initialize
window.addEventListener('load', () => {
    // Create the minimap
    createMinimap();
    
    // Load the first step
    setStep(1, true);
    
    // Initialize zoom controls
    updateZoom('reset'); // Set initial state
    
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
        
        // Auto-hide after 5 seconds
        const autoHideTimer = setTimeout(hideWelcome, 5000);
        
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
});

// Handle A-Frame scene load errors
document.querySelector('a-scene').addEventListener('loaded', () => {
    console.log('A-Frame scene loaded successfully');
});
