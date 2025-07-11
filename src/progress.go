package main

import (
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/fatih/color"
)

// ProgressIndicator handles various types of progress indication
type ProgressIndicator struct {
	writer     io.Writer
	verbose    bool
	isTerminal bool
}

// NewProgressIndicator creates a new progress indicator
func NewProgressIndicator(verbose bool) *ProgressIndicator {
	return &ProgressIndicator{
		writer:     os.Stdout,
		verbose:    verbose,
		isTerminal: isTerminal(os.Stdout),
	}
}

// Spinner represents an animated spinner
type Spinner struct {
	pi       *ProgressIndicator
	message  string
	frames   []string
	interval time.Duration
	stop     chan bool
	stopped  bool
	mu       sync.Mutex
}

// StartSpinner creates and starts a new spinner
func (pi *ProgressIndicator) StartSpinner(message string) *Spinner {
	spinner := &Spinner{
		pi:       pi,
		message:  message,
		frames:   []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"},
		interval: 100 * time.Millisecond,
		stop:     make(chan bool),
	}

	if pi.isTerminal && !pi.verbose {
		go spinner.run()
	} else {
		// For non-terminal or verbose mode, just print the message
		fmt.Fprintf(pi.writer, "%s...\n", message)
	}

	return spinner
}

// run animates the spinner
func (s *Spinner) run() {
	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()

	frame := 0
	for {
		select {
		case <-s.stop:
			s.clear()
			return
		case <-ticker.C:
			s.clear()
			fmt.Fprintf(s.pi.writer, "\r%s %s", color.CyanString(s.frames[frame]), s.message)
			frame = (frame + 1) % len(s.frames)
		}
	}
}

// Success stops the spinner with a success message
func (s *Spinner) Success(message ...string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.stopped {
		return
	}
	s.stopped = true

	msg := s.message
	if len(message) > 0 {
		msg = message[0]
	}

	if s.pi.isTerminal && !s.pi.verbose {
		close(s.stop)
		time.Sleep(50 * time.Millisecond) // Give spinner time to clear
		fmt.Fprintf(s.pi.writer, "\r%s %s\n", color.GreenString("✓"), msg)
	} else if s.pi.verbose {
		fmt.Fprintf(s.pi.writer, "%s %s\n", color.GreenString("✓"), msg)
	}
}

// Fail stops the spinner with a failure message
func (s *Spinner) Fail(message ...string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.stopped {
		return
	}
	s.stopped = true

	msg := s.message
	if len(message) > 0 {
		msg = message[0]
	}

	if s.pi.isTerminal && !s.pi.verbose {
		close(s.stop)
		time.Sleep(50 * time.Millisecond) // Give spinner time to clear
		fmt.Fprintf(s.pi.writer, "\r%s %s\n", color.RedString("✗"), msg)
	} else if s.pi.verbose {
		fmt.Fprintf(s.pi.writer, "%s %s\n", color.RedString("✗"), msg)
	}
}

// Update changes the spinner message
func (s *Spinner) Update(message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.message = message
}

// Stop stops the spinner without a message
func (s *Spinner) Stop() {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.stopped {
		return
	}
	s.stopped = true

	if s.pi.isTerminal && !s.pi.verbose {
		close(s.stop)
		time.Sleep(50 * time.Millisecond)
		s.clear()
	}
}

// clear clears the current line
func (s *Spinner) clear() {
	if s.pi.isTerminal {
		fmt.Fprintf(s.pi.writer, "\r%s\r", strings.Repeat(" ", len(s.message)+5))
	}
}

// ProgressBar represents a progress bar
type ProgressBar struct {
	pi        *ProgressIndicator
	total     int
	current   int
	message   string
	width     int
	startTime time.Time
	mu        sync.Mutex
}

// StartProgress creates and displays a progress bar
func (pi *ProgressIndicator) StartProgress(message string, total int) *ProgressBar {
	pb := &ProgressBar{
		pi:        pi,
		total:     total,
		current:   0,
		message:   message,
		width:     40,
		startTime: time.Now(),
	}

	if pi.isTerminal && !pi.verbose {
		pb.render()
	} else {
		fmt.Fprintf(pi.writer, "%s (0/%d)\n", message, total)
	}

	return pb
}

// Increment increases the progress by 1
func (pb *ProgressBar) Increment() {
	pb.Update(pb.current + 1)
}

// Update sets the current progress
func (pb *ProgressBar) Update(current int) {
	pb.mu.Lock()
	defer pb.mu.Unlock()

	pb.current = current
	if pb.current > pb.total {
		pb.current = pb.total
	}

	if pb.pi.isTerminal && !pb.pi.verbose {
		pb.render()
	} else if pb.pi.verbose {
		fmt.Fprintf(pb.pi.writer, "%s (%d/%d)\n", pb.message, pb.current, pb.total)
	}
}

// render draws the progress bar
func (pb *ProgressBar) render() {
	percent := float64(pb.current) / float64(pb.total)
	filled := int(percent * float64(pb.width))
	empty := pb.width - filled

	bar := color.GreenString(strings.Repeat("█", filled)) + strings.Repeat("░", empty)

	elapsed := time.Since(pb.startTime)
	var eta string
	if pb.current > 0 && pb.current < pb.total {
		remaining := float64(pb.total-pb.current) * (elapsed.Seconds() / float64(pb.current))
		eta = fmt.Sprintf(" ETA: %s", formatDuration(time.Duration(remaining)*time.Second))
	}

	fmt.Fprintf(pb.pi.writer, "\r%s [%s] %d/%d (%.1f%%)%s",
		pb.message, bar, pb.current, pb.total, percent*100, eta)

	if pb.current >= pb.total {
		fmt.Fprintln(pb.pi.writer)
	}
}

// Complete marks the progress as complete
func (pb *ProgressBar) Complete(message ...string) {
	pb.mu.Lock()
	defer pb.mu.Unlock()

	pb.current = pb.total
	msg := pb.message
	if len(message) > 0 {
		msg = message[0]
	}

	if pb.pi.isTerminal && !pb.pi.verbose {
		pb.render()
		fmt.Fprintf(pb.pi.writer, "%s %s - completed in %s\n",
			color.GreenString("✓"), msg, formatDuration(time.Since(pb.startTime)))
	} else {
		fmt.Fprintf(pb.pi.writer, "%s %s - completed in %s\n",
			color.GreenString("✓"), msg, formatDuration(time.Since(pb.startTime)))
	}
}

// TaskList represents a list of tasks with status
type TaskList struct {
	pi        *ProgressIndicator
	tasks     []Task
	current   int
	startTime time.Time
	mu        sync.Mutex
}

// Task represents a single task in the list
type Task struct {
	Name      string
	Status    TaskStatus
	StartTime time.Time
	EndTime   time.Time
	Error     error
}

// TaskStatus represents the status of a task
type TaskStatus int

const (
	TaskPending TaskStatus = iota
	TaskRunning
	TaskSuccess
	TaskFailed
	TaskSkipped
)

// StartTaskList creates a new task list
func (pi *ProgressIndicator) StartTaskList(taskNames []string) *TaskList {
	tasks := make([]Task, len(taskNames))
	for i, name := range taskNames {
		tasks[i] = Task{
			Name:   name,
			Status: TaskPending,
		}
	}

	tl := &TaskList{
		pi:        pi,
		tasks:     tasks,
		current:   -1,
		startTime: time.Now(),
	}

	return tl
}

// StartTask begins execution of the next task
func (tl *TaskList) StartTask() *TaskHandle {
	tl.mu.Lock()
	defer tl.mu.Unlock()

	tl.current++
	if tl.current >= len(tl.tasks) {
		return nil
	}

	tl.tasks[tl.current].Status = TaskRunning
	tl.tasks[tl.current].StartTime = time.Now()

	if tl.pi.verbose {
		fmt.Fprintf(tl.pi.writer, "Starting: %s\n", tl.tasks[tl.current].Name)
	}

	return &TaskHandle{
		taskList: tl,
		index:    tl.current,
	}
}

// TaskHandle represents a handle to a running task
type TaskHandle struct {
	taskList *TaskList
	index    int
}

// Success marks the task as successful
func (th *TaskHandle) Success() {
	th.taskList.mu.Lock()
	defer th.taskList.mu.Unlock()

	th.taskList.tasks[th.index].Status = TaskSuccess
	th.taskList.tasks[th.index].EndTime = time.Now()

	if th.taskList.pi.verbose {
		duration := th.taskList.tasks[th.index].EndTime.Sub(th.taskList.tasks[th.index].StartTime)
		fmt.Fprintf(th.taskList.pi.writer, "%s %s (%s)\n",
			color.GreenString("✓"),
			th.taskList.tasks[th.index].Name,
			formatDuration(duration))
	}
}

// Fail marks the task as failed
func (th *TaskHandle) Fail(err error) {
	th.taskList.mu.Lock()
	defer th.taskList.mu.Unlock()

	th.taskList.tasks[th.index].Status = TaskFailed
	th.taskList.tasks[th.index].EndTime = time.Now()
	th.taskList.tasks[th.index].Error = err

	if th.taskList.pi.verbose {
		fmt.Fprintf(th.taskList.pi.writer, "%s %s: %v\n",
			color.RedString("✗"),
			th.taskList.tasks[th.index].Name,
			err)
	}
}

// Skip marks the task as skipped
func (th *TaskHandle) Skip() {
	th.taskList.mu.Lock()
	defer th.taskList.mu.Unlock()

	th.taskList.tasks[th.index].Status = TaskSkipped
	th.taskList.tasks[th.index].EndTime = time.Now()

	if th.taskList.pi.verbose {
		fmt.Fprintf(th.taskList.pi.writer, "%s %s (skipped)\n",
			color.YellowString("⊖"),
			th.taskList.tasks[th.index].Name)
	}
}

// Complete finishes the task list
func (tl *TaskList) Complete() {
	tl.mu.Lock()
	defer tl.mu.Unlock()

	if tl.pi.isTerminal && !tl.pi.verbose {
		fmt.Fprintln(tl.pi.writer) // New line after progress
	}

	// Summary
	completed := 0
	failed := 0
	skipped := 0
	for _, task := range tl.tasks {
		switch task.Status {
		case TaskSuccess:
			completed++
		case TaskFailed:
			failed++
		case TaskSkipped:
			skipped++
		}
	}

	totalTime := time.Since(tl.startTime)

	if failed > 0 {
		color.Red("\n⚠️  %d task(s) failed", failed)
	}

	fmt.Fprintf(tl.pi.writer, "\nCompleted %d/%d tasks in %s",
		completed, len(tl.tasks), formatDuration(totalTime))

	if skipped > 0 {
		fmt.Fprintf(tl.pi.writer, " (%d skipped)", skipped)
	}
	fmt.Fprintln(tl.pi.writer)
}

// Helper functions

func isTerminal(w io.Writer) bool {
	if f, ok := w.(*os.File); ok {
		fi, _ := f.Stat()
		return fi.Mode()&os.ModeCharDevice != 0
	}
	return false
}

func formatDuration(d time.Duration) string {
	if d < time.Second {
		return fmt.Sprintf("%dms", d.Milliseconds())
	}
	if d < time.Minute {
		return fmt.Sprintf("%.1fs", d.Seconds())
	}
	if d < time.Hour {
		min := int(d.Minutes())
		sec := int(d.Seconds()) % 60
		return fmt.Sprintf("%dm%ds", min, sec)
	}
	hour := int(d.Hours())
	min := int(d.Minutes()) % 60
	return fmt.Sprintf("%dh%dm", hour, min)
}

func getSpinnerFrame(elapsed time.Duration) string {
	frames := []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}
	index := int(elapsed.Milliseconds()/100) % len(frames)
	return color.CyanString(frames[index])
}

// Section prints a section header
func (pi *ProgressIndicator) Section(title string) {
	fmt.Fprintf(pi.writer, "\n%s\n%s\n",
		color.New(color.Bold).Sprint(title),
		strings.Repeat("─", len(title)))
}

// Info prints an info message
func (pi *ProgressIndicator) Info(format string, args ...interface{}) {
	msg := fmt.Sprintf(format, args...)
	fmt.Fprintf(pi.writer, "%s %s\n", color.BlueString("ℹ"), msg)
}

// Success prints a success message
func (pi *ProgressIndicator) Success(format string, args ...interface{}) {
	msg := fmt.Sprintf(format, args...)
	fmt.Fprintf(pi.writer, "%s %s\n", color.GreenString("✓"), msg)
}

// Warning prints a warning message
func (pi *ProgressIndicator) Warning(format string, args ...interface{}) {
	msg := fmt.Sprintf(format, args...)
	fmt.Fprintf(pi.writer, "%s %s\n", color.YellowString("⚠"), msg)
}

// Error prints an error message
func (pi *ProgressIndicator) Error(format string, args ...interface{}) {
	msg := fmt.Sprintf(format, args...)
	fmt.Fprintf(pi.writer, "%s %s\n", color.RedString("✗"), msg)
}

// Debug prints a debug message (only in verbose mode)
func (pi *ProgressIndicator) Debug(format string, args ...interface{}) {
	if pi.verbose {
		msg := fmt.Sprintf(format, args...)
		fmt.Fprintf(pi.writer, "%s %s\n", color.MagentaString("⚙"), msg)
	}
}
