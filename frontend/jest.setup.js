require('@testing-library/jest-dom');
require('jest-canvas-mock');

// Polyfill for CanvasRenderingContext2D.roundRect which is missing in jest-canvas-mock
if (!window.CanvasRenderingContext2D.prototype.roundRect) {
    window.CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, radii) {
        this.rect(x, y, w, h);
    };
}

// Polyfill for fetch
global.fetch = jest.fn(() =>
    Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
        blob: () => Promise.resolve(new Blob(['dummy'], { type: 'video/mp4' })),
    })
);
