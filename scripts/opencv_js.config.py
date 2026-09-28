# The OpenCV.js whitelist for this app: exactly the functions the detector
# and the warp call (js/scan-worker.js, js/worker/*.js), nothing more. The Mat,
# MatVector, Size and Scalar classes and the matFrom* helpers are bound by
# OpenCV.js itself and need no entry. A function missing from this list
# fails at runtime as "cv.<name> is not a function", so any new cv.* call in
# the worker has to be added here and the build re-run
# (scripts/build-opencv.sh).

core = {
    '': [
        'inRange',
        'split',
    ],
}

imgproc = {
    '': [
        'adaptiveThreshold',
        'approxPolyDP',
        'arcLength',
        'Canny',
        'contourArea',
        'convexHull',
        'convexityDefects',
        'cvtColor',
        'dilate',
        'findContours',
        'GaussianBlur',
        'getPerspectiveTransform',
        'getStructuringElement',
        'HoughLinesP',
        'morphologyEx',
        'resize',
        'Scharr',
        'threshold',
        'warpPerspective',
    ],
}

white_list = makeWhiteList([core, imgproc])
