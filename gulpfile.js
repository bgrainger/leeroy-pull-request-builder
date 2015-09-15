var babel = require('gulp-babel');
var gulp = require('gulp');
var sourcemaps = require('gulp-sourcemaps');

gulp.task('default', function () {
	return gulp.src('src/*.js')
		.pipe(sourcemaps.init())
		.pipe(babel({ optional: ['runtime'] }))
		.pipe(sourcemaps.write('.'))
		.pipe(gulp.dest('dist'));
});
