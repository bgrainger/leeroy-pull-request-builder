var babel = require('gulp-babel');
var batch = require('gulp-batch');
var eslint = require('gulp-eslint');
var gulp = require('gulp');
var sourcemaps = require('gulp-sourcemaps');
var watch = require('gulp-watch');

gulp.task('lint', function() {
	return gulp.src('src/*.js')
		.pipe(eslint())
		.pipe(eslint.format())
		.pipe(eslint.failOnError());
});

gulp.task('default', ['lint'], function() {
	return gulp.src('src/*.js')
		.pipe(sourcemaps.init())
		.pipe(babel({ optional: ['runtime'] }))
		.pipe(sourcemaps.write('.'))
		.pipe(gulp.dest('dist'));
});

gulp.task('watch', ['default'], function() {
	watch('src/*.js', batch(function(events, done) {
		gulp.start('default', done);
	}));
});
