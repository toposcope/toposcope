package main

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"runtime/debug"

	"github.com/gin-gonic/gin"
)

func main() {
	gin.SetMode(gin.ReleaseMode)
	router := gin.New()

	// The uncaught-error path: the panic and its stack as the runtime prints them.
	router.Use(func(c *gin.Context) {
		defer func() {
			if recovered := recover(); recovered != nil {
				stack := fmt.Sprintf("panic: %v\n\n%s", recovered, debug.Stack())
				_ = os.WriteFile(os.Getenv("OUT"), []byte(stack), 0o644)
				_ = os.WriteFile(os.Getenv("OUT")+".type", []byte(fmt.Sprintf("%T", recovered)), 0o644)
				c.AbortWithStatus(http.StatusInternalServerError)
			}
		}()
		c.Next()
	})

	router.POST("/pay", func(c *gin.Context) {
		c.String(http.StatusOK, charge(&Order{}))
	})

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		panic(err)
	}
	go func() { _ = http.Serve(listener, router) }()
	response, err := http.Post("http://"+listener.Addr().String()+"/pay", "application/json", nil)
	if err == nil {
		response.Body.Close()
	}
}
